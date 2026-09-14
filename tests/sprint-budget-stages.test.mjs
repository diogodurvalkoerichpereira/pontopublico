/**
 * O2-03 (Onda 2) — liquidação, pagamento e anulação do empenho: COMPORTAMENTO.
 *
 * Estágios da despesa (Lei 4.320): empenhado -> liquidado -> pago; anular devolve
 * o saldo à dotação. Confere a máquina de estados e a devolução do saldo.
 *
 * Mutação: anular sem devolver o saldo, ou permitir pagar sem liquidar, derruba.
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

const dir = mkdtempSync(join(tmpdir(), "stages-test-"));

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

function empenhar(valor) {
  return fn.createBudgetCommitment({
    data: {
      tenant_id: tenantId,
      appropriation_id: dotacaoId,
      data_empenho: "2026-03-15",
      credor: "Fornecedor X",
      historico: "Aquisicao",
      valor,
    },
    context: ctx(),
  });
}
const move = (commitment_id, action) =>
  fn.transitionBudgetCommitment({
    data: { tenant_id: tenantId, commitment_id, action },
    context: ctx(),
  });
async function statusOf(id) {
  return (
    await db.query("select status from public.budget_commitments where id=$1", [
      id,
    ])
  ).rows[0].status;
}
async function empenhado() {
  const ws = await fn.getBudgetAppropriations({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  return Number(
    ws.appropriations.find((a) => a.id === dotacaoId).valor_empenhado,
  );
}

test("empenhado -> liquidado; a transição não paga (pagar é da ordem bancária)", async () => {
  const { id } = await empenhar(60000);
  await move(id, "liquidar");
  assert.equal(await statusOf(id), "liquidado");
  // "pagar" não é mais ação desta função: pagar é saída de caixa, e só a ordem
  // bancária debita a tesouraria. A transição marcava 'pago' sem mover o caixa,
  // deixando a conciliação com uma diferença sem origem.
  await assert.rejects(move(id, "pagar"));
  assert.equal(await statusOf(id), "liquidado");
});

test("anular devolve o saldo à dotação", async () => {
  const antes = await empenhado();
  const { id } = await empenhar(20000);
  assert.equal(await empenhado(), antes + 20000);
  await move(id, "anular");
  assert.equal(await statusOf(id), "anulado");
  assert.equal(await empenhado(), antes, "o saldo deve voltar ao anular");
});

test("empenho pago não pode ser anulado", async () => {
  const { id } = await empenhar(5000);
  await move(id, "liquidar");
  // Pago pela ordem bancária (simulado aqui: o estágio é o que importa).
  await db.query(
    "update public.budget_commitments set status='pago', pago_em=now() where id=$1",
    [id],
  );
  await assert.rejects(move(id, "anular"), /pago não pode ser anulado/);
});
