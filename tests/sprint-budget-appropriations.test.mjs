/**
 * O2-01 (Onda 2) — dotação orçamentária: teste de COMPORTAMENTO (ponta a ponta).
 *
 * saveBudgetAppropriation cria/edita a dotação; getBudgetAppropriations lê com o
 * saldo (orçado - empenhado). Confere: dedup pela classificação orçamentária
 * completa; saldo calculado; e que não se pode orçar abaixo do já empenhado.
 *
 * Mutação: remover o dedup (duplicata aceita) ou a checagem de orçado>=empenhado derruba.
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

const dir = mkdtempSync(join(tmpdir(), "budget-test-"));

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
const baseDotacao = (over = {}) => ({
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
  ...over,
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
  Object.assign(fn, await bundle("src/lib/budget.functions.ts", "b.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("cria a dotação e lê com saldo = orçado - empenhado", async () => {
  const { id } = await fn.saveBudgetAppropriation({
    data: baseDotacao(),
    context: ctx(),
  });
  const ws = await fn.getBudgetAppropriations({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  assert.equal(ws.appropriations.length, 1);
  const row = ws.appropriations[0];
  assert.equal(row.id, id);
  assert.equal(Number(row.valor_orcado), 100000);
  assert.equal(Number(row.valor_empenhado), 0);
  assert.equal(Number(row.saldo), 100000);
  assert.equal(ws.canManage, true);
});

test("dedup: mesma classificação no exercício é recusada", async () => {
  await assert.rejects(
    fn.saveBudgetAppropriation({ data: baseDotacao(), context: ctx() }),
    /Já existe dotação/,
  );
  // Classificação diferente (outra natureza) é aceita.
  const ok = await fn.saveBudgetAppropriation({
    data: baseDotacao({ natureza_despesa: "3.1.90.13.00" }),
    context: ctx(),
  });
  assert.ok(ok.id);
});

test("não se pode orçar abaixo do já empenhado", async () => {
  const { id } = await fn.saveBudgetAppropriation({
    data: baseDotacao({ acao: "2099", valor_orcado: 50000 }),
    context: ctx(),
  });
  // Simula empenho reservado nesta dotação.
  await db.query(
    "update public.budget_appropriations set valor_empenhado = 40000 where id = $1",
    [id],
  );
  await assert.rejects(
    fn.saveBudgetAppropriation({
      data: baseDotacao({ id, acao: "2099", valor_orcado: 30000 }),
      context: ctx(),
    }),
    /menor que o já empenhado/,
  );
  // Reduzir até o empenhado (40000) é permitido.
  const ok = await fn.saveBudgetAppropriation({
    data: baseDotacao({ id, acao: "2099", valor_orcado: 40000 }),
    context: ctx(),
  });
  assert.equal(ok.id, id);
});
