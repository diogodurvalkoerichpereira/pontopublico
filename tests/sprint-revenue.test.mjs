/**
 * O2-08 (Onda 2) — receita: previsão e arrecadação: COMPORTAMENTO (ponta a ponta).
 *
 * saveBudgetRevenue prevê a receita; recordRevenueCollection arrecada e incrementa
 * o valor_arrecadado; getBudgetRevenues lê com saldo. Confere a arrecadação e que
 * a previsão não pode cair abaixo do arrecadado.
 *
 * Mutação: não incrementar o arrecadado derruba.
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

const dir = mkdtempSync(join(tmpdir(), "revenue-test-"));

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
let revenueId;

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
  Object.assign(fn, await bundle("src/lib/revenue.functions.ts", "r.mjs"));
  revenueId = (
    await fn.saveBudgetRevenue({
      data: {
        tenant_id: tenantId,
        exercicio: 2026,
        natureza_receita: "1.1.1.2.01",
        fonte_recurso: "1.500.0000",
        descricao: "ISS",
        valor_previsto: 100000,
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

test("a arrecadação incrementa o valor arrecadado e reduz o saldo", async () => {
  await fn.recordRevenueCollection({
    data: {
      tenant_id: tenantId,
      revenue_id: revenueId,
      data_arrecadacao: "2026-03-10",
      valor: 30000,
      historico: "Arrecadacao ISS marco",
    },
    context: ctx(),
  });
  await fn.recordRevenueCollection({
    data: {
      tenant_id: tenantId,
      revenue_id: revenueId,
      data_arrecadacao: "2026-04-10",
      valor: 20000,
      historico: "Arrecadacao ISS abril",
    },
    context: ctx(),
  });
  const ws = await fn.getBudgetRevenues({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  const row = ws.revenues.find((r) => r.id === revenueId);
  assert.equal(Number(row.valor_arrecadado), 50000);
  assert.equal(Number(row.saldo), 50000);
  assert.equal(ws.totais.arrecadado, 50000);
});

test("previsão não pode cair abaixo do já arrecadado", async () => {
  await assert.rejects(
    fn.saveBudgetRevenue({
      data: {
        id: revenueId,
        tenant_id: tenantId,
        exercicio: 2026,
        natureza_receita: "1.1.1.2.01",
        fonte_recurso: "1.500.0000",
        descricao: "ISS",
        valor_previsto: 40000,
        status: "ativa",
      },
      context: ctx(),
    }),
    /menor que o já arrecadado/,
  );
});
