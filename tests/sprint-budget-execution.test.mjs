/**
 * O2-07 (Onda 2) — balanço da execução orçamentária: COMPORTAMENTO (ponta a ponta).
 *
 * getBudgetExecution agrega por dotação: orçado × empenhado × liquidado × pago ×
 * restos a pagar. Confere os estágios e que restos a pagar = empenhado não pago;
 * empenho anulado não conta.
 *
 * Mutação: contar empenho anulado no empenhado, ou trocar o filtro de pago, derruba.
 * Cobre também que "a pagar" (empenhado não pago do exercício) e "restos a pagar"
 * (o inscrito) são coisas distintas, que o saldo desconta o contingenciado, e que
 * reduzir o orçado abaixo do comprometido é recusado com mensagem — não com erro
 * cru do Postgres.
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
  // "A pagar" é o empenhado do exercício ainda não pago. NÃO é resto a pagar:
  // resto só nasce da inscrição no encerramento (Lei 4.320 art. 36).
  assert.equal(Number(row.a_pagar), 30000, "empenhado nao pago: 20+10");
  assert.equal(
    Number(row.restos_a_pagar),
    0,
    "nada inscrito em restos a pagar ainda",
  );

  assert.equal(exec.totais.empenhado, 60000);
  assert.equal(exec.totais.pago, 30000);
  assert.equal(exec.totais.a_pagar, 30000);
  assert.equal(exec.totais.restos_a_pagar, 0);
});

test("restos a pagar só conta o inscrito, e não se confunde com o a pagar", async () => {
  // Inscreve o empenho B (liquidado, não pago) em restos a pagar. O mesmo valor
  // não pode aparecer duas vezes: continua em "a pagar" do exercício de origem e
  // passa a existir como resto inscrito — são vistas diferentes, somá-las dobra
  // a despesa.
  const b = (
    await db.query(
      `select id, valor from public.budget_commitments
       where appropriation_id=$1 and status='liquidado' order by valor desc limit 1`,
      [dotacaoId],
    )
  ).rows[0];
  await db.query(
    `insert into public.restos_a_pagar
       (id, tenant_id, commitment_id, exercicio_origem, tipo, valor, status, inscrito_em)
     values (gen_random_uuid(), $1, $2, 2026, 'processado', $3, 'inscrito', '2026-12-31')`,
    [tenantId, b.id, b.valor],
  );

  const exec = await fn.getBudgetExecution({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  const row = exec.rows.find((r) => r.appropriation_id === dotacaoId);
  assert.equal(Number(row.restos_a_pagar), 20000, "só o inscrito");
  assert.equal(Number(row.a_pagar), 30000, "a pagar do exercício não muda");
});

test("saldo da dotação desconta o contingenciado (LRF art. 9º)", async () => {
  await db.query(
    "update public.budget_appropriations set valor_bloqueado=15000 where id=$1",
    [dotacaoId],
  );
  const exec = await fn.getBudgetExecution({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  const row = exec.rows.find((r) => r.appropriation_id === dotacaoId);
  assert.equal(Number(row.bloqueado), 15000);
  // 100k - 60k empenhado - 15k bloqueado. O bloqueado não é empenhável.
  assert.equal(Number(row.saldo_dotacao), 25000);
  assert.equal(exec.totais.bloqueado, 15000);
  await db.query(
    "update public.budget_appropriations set valor_bloqueado=0 where id=$1",
    [dotacaoId],
  );
});

test("reduzir o orcado abaixo do empenhado + contingenciado e recusado com mensagem", async () => {
  // O banco tem `valor_empenhado + valor_bloqueado <= valor_orcado`. Sem validar o
  // bloqueado na aplicação, a redução estourava o check e o usuário via o erro cru
  // do Postgres, sem saber que o caminho era liberar o contingenciamento antes.
  await db.query(
    "update public.budget_appropriations set valor_bloqueado=30000 where id=$1",
    [dotacaoId],
  );
  const salvar = (valor_orcado) =>
    fn.saveBudgetAppropriation({
      data: {
        id: dotacaoId,
        tenant_id: tenantId,
        exercicio: 2026,
        unidade_orcamentaria: "02.01",
        funcao: "04",
        subfuncao: "122",
        programa: "0001",
        acao: "2001",
        natureza_despesa: "3.1.90.11.00",
        fonte_recurso: "1.500.0000",
        valor_orcado,
        status: "ativa",
      },
      context: ctx(),
    });

  // 60k empenhado + 30k bloqueado = 90k comprometido. 80k não cobre.
  await assert.rejects(
    salvar(80000),
    /nao cobre o comprometido|não cobre o comprometido/,
  );
  // 95k cobre e passa.
  await salvar(95000);
  const row = (
    await db.query(
      "select valor_orcado::text from public.budget_appropriations where id=$1",
      [dotacaoId],
    )
  ).rows[0];
  assert.equal(Number(row.valor_orcado), 95000);
  await db.query(
    "update public.budget_appropriations set valor_bloqueado=0, valor_orcado=100000 where id=$1",
    [dotacaoId],
  );
});
