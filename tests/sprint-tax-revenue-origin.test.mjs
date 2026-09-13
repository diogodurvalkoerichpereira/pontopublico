/**
 * O4-14c (Onda 4) — receita de dívida ativa consolidada: COMPORTAMENTO.
 *
 * Cada pagamento grava a ORIGEM no momento em que é feito: 'divida_ativa' se o
 * crédito estava inscrito, 'corrente' caso contrário — no pagamento avulso
 * (recordTaxPayment) e na parcela (payInstallment). getTaxRevenueByOrigin
 * consolida o exercício por tributo e origem. Quitar o crédito (que apaga o status
 * de dívida ativa) não apaga a origem da receita.
 *
 * Mutação: gravar sempre 'corrente' no pagamento avulso zera a receita de dívida
 * ativa do IPTU — derruba.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { createTestDb } from "./helpers/pglite.mjs";

let db;
let tenantId;
let userId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "tax-origin-test-"));

const dbStub = join(dir, "db.mjs");
writeFileSync(
  dbStub,
  `export async function query(t, p) { const r = await globalThis.__db.query(t, p ?? []); return r.rows; }
   export async function queryOne(t, p) { const r = await globalThis.__db.query(t, p ?? []); return r.rows[0] ?? null; }
   export async function withTransaction(fn) { return fn({ query: async (t, p) => globalThis.__db.query(t, p ?? []) }); }`,
);
const startStub = join(dir, "start.mjs");
writeFileSync(
  startStub,
  `export function createServerFn() {
     let validate = (x) => x;
     const b = { middleware() { return b; }, validator(fn) { validate = fn; return b; },
       inputValidator(fn) { validate = fn; return b; },
       handler(fn) { return async ({ data, context }) => fn({ data: validate(data), context }); } };
     return b;
   }`,
);
const dataStub = join(dir, "data.mjs");
writeFileSync(dataStub, `export const requireAuth = {};`);
const taStub = join(dir, "ta.mjs");
writeFileSync(
  taStub,
  `const PERMS = ["taxes.read","taxes.manage"];
   export async function loadTenantAccess() { return { permissions: PERMS }; }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }`,
);
const auditStub = join(dir, "audit.mjs");
writeFileSync(
  auditStub,
  `export async function recordAudit() {} export async function recordAuditQ() {}`,
);

function stubPlugin() {
  return {
    name: "stub",
    setup(b) {
      const map = [
        [/@tanstack\/react-start$/, startStub],
        [/(^|\/)db\.server$/, dbStub],
        [/(^|\/)data\.functions$/, dataStub],
        [/(^|\/)tenant-access\.server$/, taStub],
        [/(^|\/)audit\.server$/, auditStub],
      ];
      for (const [filter, path] of map)
        b.onResolve({ filter }, () => ({ path, external: true }));
    },
  };
}

async function bundle(entry, name) {
  const out = join(dir, name);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
    external: ["node:*"],
    plugins: [stubPlugin()],
  });
  return import(out);
}

const ctx = () => ({ userId });

let seq = 0;
async function seedCredit(tributo, valor, status = "lancado") {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, vencimento, status)
     values ($1,$2,$3,2026,'C','000',$4,$5,'2026-01-31',$6)`,
    [id, tenantId, tributo, `INS-${seq}`, valor, status],
  );
  return id;
}
const pay = (creditId, valor, data = "2026-04-10") =>
  fn.recordTaxPayment({
    data: {
      tenant_id: tenantId,
      credit_id: creditId,
      data_pagamento: data,
      valor,
    },
    context: ctx(),
  });
const byOrigin = (exercicio = 2026) =>
  fn.getTaxRevenueByOrigin({
    data: { tenant_id: tenantId, exercicio },
    context: ctx(),
  });

before(async () => {
  db = await createTestDb();
  globalThis.__db = db;
  tenantId = (
    await db.query(
      "select id from public.tenants order by created_at, id limit 1",
    )
  ).rows[0].id;
  userId = randomUUID();
  await db.query(
    "insert into public.app_users (id, email, password_hash) values ($1,$2,'x')",
    [userId, `a-${userId}@t.local`],
  );
  await db.query("insert into public.profiles (id) values ($1)", [userId]);
  Object.assign(fn, await bundle("src/lib/taxes.functions.ts", "tx.mjs"));
  Object.assign(
    fn,
    await bundle("src/lib/tax-installments.functions.ts", "ti.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("pagamento grava a origem; consolida corrente × dívida ativa por tributo e exercício", async () => {
  // IPTU corrente: 300 pagos com o crédito lançado.
  const corrente = await seedCredit("IPTU", 1000);
  await pay(corrente, 300);

  // IPTU em dívida ativa: 500 pagos; depois quita (o status vira 'quitado', mas a
  // origem dos pagamentos permanece).
  const inscrito = await seedCredit("IPTU", 800, "divida_ativa");
  await pay(inscrito, 500);
  const q = await pay(inscrito, 300);
  assert.equal(q.quitado, true);

  // ISS em dívida ativa parcelado em 2: a 1ª parcela (200) é receita de dívida ativa.
  const parcelado = await seedCredit("ISS", 400, "divida_ativa");
  const plan = await fn.createInstallmentPlan({
    data: {
      tenant_id: tenantId,
      credit_id: parcelado,
      numero_parcelas: 2,
      data_acordo: "2026-03-01",
      primeiro_vencimento: "2026-04-05",
    },
    context: ctx(),
  });
  const parcelas = await fn.getInstallments({
    data: { tenant_id: tenantId, plan_id: plan.plan_id },
    context: ctx(),
  });
  await fn.payInstallment({
    data: {
      tenant_id: tenantId,
      installment_id: parcelas[0].id,
      data_pagamento: "2026-04-05",
    },
    context: ctx(),
  });

  // Pagamento de outro exercício não entra em 2026.
  const antigo = await seedCredit("TAXA", 100);
  await pay(antigo, 100, "2025-12-20");

  const origens = (
    await db.query(
      `select origem, sum(valor)::text as total from public.tax_payments
       where tenant_id=$1 group by origem order by origem`,
      [tenantId],
    )
  ).rows;
  assert.deepEqual(origens, [
    { origem: "corrente", total: "400.00" }, // 300 + 100 (2025)
    { origem: "divida_ativa", total: "1000.00" }, // 500 + 300 + 200
  ]);

  const r = await byOrigin(2026);
  assert.deepEqual(r.totais, {
    corrente: 300,
    divida_ativa: 1000,
    total: 1300,
  });
  assert.deepEqual(r.tributos, [
    { tributo: "IPTU", corrente: 300, divida_ativa: 800, total: 1100 },
    { tributo: "ISS", corrente: 0, divida_ativa: 200, total: 200 },
  ]);

  const r2025 = await byOrigin(2025);
  assert.deepEqual(r2025.totais, {
    corrente: 100,
    divida_ativa: 0,
    total: 100,
  });
});
