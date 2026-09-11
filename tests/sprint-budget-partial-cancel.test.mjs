/**
 * O2-03b (Onda 2) — anulação parcial de empenho (Lei 4.320 art. 59): COMPORTAMENTO.
 *
 * partiallyCancelBudgetCommitment reduz o valor de um empenho ainda 'empenhado' e devolve
 * a diferença ao saldo empenhado da dotação. Só reduz (novo valor < atual) e só no estágio
 * 'empenhado'. Confere a devolução do saldo e as recusas.
 *
 * Mutação: não devolver a diferença à dotação, ou permitir anular parcialmente um empenho
 * liquidado, derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "partial-cancel-test-"));

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
      credor: "Fornecedor X",
      historico: "Aquisicao",
      valor,
    },
    context: ctx(),
  });
const partial = (commitment_id, novo_valor) =>
  fn.partiallyCancelBudgetCommitment({
    data: {
      tenant_id: tenantId,
      commitment_id,
      novo_valor,
      motivo: "Reducao de escopo",
    },
    context: ctx(),
  });
async function empenhadoDotacao() {
  const ws = await fn.getBudgetAppropriations({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  return Number(
    ws.appropriations.find((a) => a.id === dotacaoId).valor_empenhado,
  );
}

test("reduz o empenho e devolve a diferença à dotação", async () => {
  const { id } = await empenhar(60000);
  assert.equal(await empenhadoDotacao(), 60000);

  const r = await partial(id, 40000);
  assert.equal(r.valor, 40000);
  assert.equal(r.devolvido, 20000);

  // Dotação recuperou os 20.000.
  assert.equal(await empenhadoDotacao(), 40000);
  // O empenho passou a valer 40.000.
  const c = (
    await db.query(
      "select valor::text v from public.budget_commitments where id=$1",
      [id],
    )
  ).rows[0];
  assert.equal(Number(c.v), 40000);
});

test("recusa novo valor >= atual e empenho já liquidado", async () => {
  const { id } = await empenhar(10000);
  await assert.rejects(partial(id, 10000), /menor que/i);
  await assert.rejects(partial(id, 15000), /menor que/i);

  // Liquidado não admite anulação parcial.
  await fn.transitionBudgetCommitment({
    data: { tenant_id: tenantId, commitment_id: id, action: "liquidar" },
    context: ctx(),
  });
  await assert.rejects(partial(id, 5000), /empenhado/i);
});
