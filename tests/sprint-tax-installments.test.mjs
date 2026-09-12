/**
 * O4-02 (Onda 4) — parcelamento de dívida ativa: COMPORTAMENTO (ponta a ponta).
 *
 * createInstallmentPlan rateia o saldo em N parcelas (última absorve o
 * arredondamento); payInstallment arrecada cada parcela no crédito e a última
 * quita crédito e plano. Confere o rateio exato, a quitação ao fim e que só um
 * crédito em dívida ativa é parcelável.
 *
 * Mutação: não quitar o crédito ao pagar a última parcela derruba.
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

const dir = mkdtempSync(join(tmpdir(), "tax-inst-test-"));

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

// Cria um crédito em dívida ativa direto no banco (o fluxo de tributos já é
// testado em sprint-taxes); aqui interessa o parcelamento.
async function seedCreditDividaAtiva(valor, inscricao) {
  const id = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, vencimento, status)
     values ($1,$2,'IPTU',2024,'Fulano','000','${inscricao}',$3,'2024-05-01','divida_ativa')`,
    [id, tenantId, valor],
  );
  return id;
}

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

test("rateia saldo em 3 parcelas com soma exata e quita ao fim", async () => {
  // 100.00 / 3 => 33.33, 33.33, 33.34 (última absorve).
  const creditId = await seedCreditDividaAtiva(100, "INS-A");
  const plan = await fn.createInstallmentPlan({
    data: {
      tenant_id: tenantId,
      credit_id: creditId,
      numero_parcelas: 3,
      data_acordo: "2025-01-10",
      primeiro_vencimento: "2025-02-10",
    },
    context: ctx(),
  });
  assert.equal(plan.numero_parcelas, 3);
  assert.equal(plan.valor_parcela, 33.33);

  const parcelas = (
    await db.query(
      `select id, numero, valor::text, vencimento::text from public.tax_installments
       where plan_id=$1 order by numero`,
      [plan.plan_id],
    )
  ).rows;
  assert.equal(parcelas.length, 3);
  const soma = parcelas.reduce((s, p) => s + Number(p.valor), 0);
  assert.equal(Number(soma.toFixed(2)), 100);
  assert.equal(parcelas[2].valor, "33.34");
  // Vencimentos mensais.
  assert.equal(parcelas[0].vencimento, "2025-02-10");
  assert.equal(parcelas[1].vencimento, "2025-03-10");
  assert.equal(parcelas[2].vencimento, "2025-04-10");

  // Paga as três; a última quita crédito e plano.
  for (let i = 0; i < 3; i++) {
    const r = await fn.payInstallment({
      data: {
        tenant_id: tenantId,
        installment_id: parcelas[i].id,
        data_pagamento: "2025-02-11",
      },
      context: ctx(),
    });
    assert.equal(r.plano_quitado, i === 2);
  }
  const credit = (
    await db.query(
      "select status, valor_pago::text from public.tax_credits where id=$1",
      [creditId],
    )
  ).rows[0];
  assert.equal(credit.status, "quitado");
  assert.equal(credit.valor_pago, "100.00");
  const planRow = (
    await db.query(
      "select status from public.tax_installment_plans where id=$1",
      [plan.plan_id],
    )
  ).rows[0];
  assert.equal(planRow.status, "quitado");
});

test("só crédito em dívida ativa é parcelável e parcela não paga duas vezes", async () => {
  const lancadoId = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, vencimento, status)
     values ($1,$2,'ISS',2024,'Beltrano','111','INS-B',50,'2024-05-01','lancado')`,
    [lancadoId, tenantId],
  );
  await assert.rejects(
    fn.createInstallmentPlan({
      data: {
        tenant_id: tenantId,
        credit_id: lancadoId,
        numero_parcelas: 2,
        data_acordo: "2025-01-10",
        primeiro_vencimento: "2025-02-10",
      },
      context: ctx(),
    }),
    /dívida ativa/,
  );

  const creditId = await seedCreditDividaAtiva(60, "INS-C");
  const plan = await fn.createInstallmentPlan({
    data: {
      tenant_id: tenantId,
      credit_id: creditId,
      numero_parcelas: 2,
      data_acordo: "2025-01-10",
      primeiro_vencimento: "2025-02-10",
    },
    context: ctx(),
  });
  // Segundo plano no mesmo crédito é recusado (um ativo por crédito).
  await assert.rejects(
    fn.createInstallmentPlan({
      data: {
        tenant_id: tenantId,
        credit_id: creditId,
        numero_parcelas: 3,
        data_acordo: "2025-01-11",
        primeiro_vencimento: "2025-03-10",
      },
      context: ctx(),
    }),
    /parcelamento ativo/,
  );

  const primeira = (
    await db.query(
      "select id from public.tax_installments where plan_id=$1 and numero=1",
      [plan.plan_id],
    )
  ).rows[0];
  await fn.payInstallment({
    data: {
      tenant_id: tenantId,
      installment_id: primeira.id,
      data_pagamento: "2025-02-11",
    },
    context: ctx(),
  });
  await assert.rejects(
    fn.payInstallment({
      data: {
        tenant_id: tenantId,
        installment_id: primeira.id,
        data_pagamento: "2025-02-12",
      },
      context: ctx(),
    }),
    /já está paga/,
  );
});
