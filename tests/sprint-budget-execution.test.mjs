/**
 * O2-07 (Onda 2) — balanço da execução orçamentária: COMPORTAMENTO (ponta a ponta).
 *
 * getBudgetExecution agrega por dotação: orçado × empenhado × liquidado × pago ×
 * restos a pagar. Confere os estágios e que restos a pagar = empenhado não pago;
 * empenho anulado não conta.
 *
 * Mutação: contar empenho anulado no empenhado, ou trocar o filtro de pago, derruba.
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
let dotacaoId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "execution-test-"));

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
  `const PERMS = ["budget.read","budget.manage"];
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
  Object.assign(fn, await bundle("src/lib/budget.functions.ts", "b.mjs"));
  dotacaoId = (
    await fn.saveBudgetAppropriation({
      data: {
        tenant_id: tenantId,
        exercicio: 2026,
        unidade_orcamentaria: "02.01",
        funcao: "04",
        subfuncao: "122",
        programa: "0001",
        acao: "2001",
        natureza_despesa: "3.1.90.11.00",
        fonte_recurso: "1.500.0000",
        valor_orcado: 100000,
        status: "ativa",
      },
      context: ctx(),
    })
  ).id;
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const empenhar = (valor) =>
  fn.createBudgetCommitment({
    data: {
      tenant_id: tenantId,
      appropriation_id: dotacaoId,
      data_empenho: "2026-03-15",
      credor: "Fornecedor",
      historico: "Compra",
      valor,
    },
    context: ctx(),
  });
const move = (commitment_id, action) =>
  fn.transitionBudgetCommitment({
    data: { tenant_id: tenantId, commitment_id, action },
    context: ctx(),
  });

test("balanço da execução: orçado × empenhado × liquidado × pago × restos a pagar", async () => {
  // A: 30k empenhado→liquidado→pago. B: 20k empenhado→liquidado (não pago).
  // C: 10k só empenhado. D: 5k empenhado depois anulado (não conta).
  const a = await empenhar(30000);
  await move(a.id, "liquidar");
  // O pagamento é da ordem bancária; aqui só interessa o estágio no relatório.
  await db.query(
    "update public.budget_commitments set status='pago', pago_em='2026-03-01' where id=$1",
    [a.id],
  );
  const b = await empenhar(20000);
  await move(b.id, "liquidar");
  await empenhar(10000);
  const d = await empenhar(5000);
  await move(d.id, "anular");

  const exec = await fn.getBudgetExecution({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  const row = exec.rows.find((r) => r.appropriation_id === dotacaoId);
  assert.equal(Number(row.valor_orcado), 100000);
  assert.equal(Number(row.empenhado), 60000, "30+20+10 (anulado fora)");
  assert.equal(Number(row.liquidado), 50000, "30+20");
  assert.equal(Number(row.pago), 30000);
  assert.equal(Number(row.saldo_dotacao), 40000, "100k - 60k empenhado");
  assert.equal(Number(row.restos_a_pagar), 30000, "empenhado nao pago: 20+10");

  assert.equal(exec.totais.empenhado, 60000);
  assert.equal(exec.totais.pago, 30000);
  assert.equal(exec.totais.restos_a_pagar, 30000);
});
