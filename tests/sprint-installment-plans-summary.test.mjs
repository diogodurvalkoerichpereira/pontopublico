/**
 * O4-02b (Onda 4) — Carteira de parcelamentos (REFIS): COMPORTAMENTO.
 *
 * getInstallmentPlansSummary consolida os planos por situação e, nas parcelas: arrecadado
 * (pagas), a receber (abertas de planos AINDA ativos) e vencido (abertas de plano ativo
 * com vencimento < referência). Parcela aberta de plano RESCINDIDO não é mais recebível
 * pela via do parcelamento e não entra em "a receber"/"vencido".
 *
 * Mutação: contar parcelas de planos não-ativos em "a receber" (remover o filtro
 * p.status='ativo'), ou ignorar o vencimento no "vencido", derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "installment-summary-test-"));

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

let credSeq = 0;
async function seedCredit() {
  credSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, vencimento, status)
     values ($1,$2,'IPTU',2025,'Contribuinte','00000000000',$3,1000,'2025-06-01','divida_ativa')`,
    [id, tenantId, `INS-${credSeq}`],
  );
  return id;
}

let planSeq = 0;
async function seedPlan(status, valorTotal, numeroParcelas) {
  planSeq += 1;
  const id = randomUUID();
  const credit = await seedCredit();
  await db.query(
    `insert into public.tax_installment_plans
       (id, tenant_id, credit_id, numero_parcelas, valor_total, data_acordo, status)
     values ($1,$2,$3,$4,$5,'2026-01-01',$6)`,
    [id, tenantId, credit, numeroParcelas, valorTotal, status],
  );
  return id;
}

async function seedInstallment(planId, numero, valor, vencimento, status) {
  await db.query(
    `insert into public.tax_installments
       (id, tenant_id, plan_id, numero, valor, vencimento, status)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), tenantId, planId, numero, valor, vencimento, status],
  );
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

test("consolida planos e parcelas; ignora recebíveis de plano rescindido", async () => {
  // Referência 2026-06-01.
  // Plano A (ativo): 4 x 100. Parcela 1 paga; 2 vencida (aberta, venc. passado);
  // 3 e 4 abertas futuras.
  const a = await seedPlan("ativo", 400, 4);
  await seedInstallment(a, 1, 100, "2026-03-01", "paga");
  await seedInstallment(a, 2, 100, "2026-05-01", "aberta"); // vencida
  await seedInstallment(a, 3, 100, "2026-07-01", "aberta");
  await seedInstallment(a, 4, 100, "2026-08-01", "aberta");
  // Plano B (rescindido): 2 x 50, ambas abertas e vencidas — NÃO conta em a receber/vencido.
  const b = await seedPlan("rescindido", 100, 2);
  await seedInstallment(b, 1, 50, "2026-02-01", "aberta");
  await seedInstallment(b, 2, 50, "2026-03-01", "aberta");

  const r = await fn.getInstallmentPlansSummary({
    data: { tenant_id: tenantId, data_referencia: "2026-06-01" },
    context: ctx(),
  });

  assert.deepEqual(r.planosPorStatus, {
    ativo: 1,
    quitado: 0,
    rescindido: 1,
  });
  assert.equal(r.arrecadado, 100); // só a parcela 1 do plano A
  assert.equal(r.aReceber, 300); // parcelas 2,3,4 do plano A; nada do rescindido
  assert.equal(r.vencido, 100); // só a parcela 2 do plano A
});
