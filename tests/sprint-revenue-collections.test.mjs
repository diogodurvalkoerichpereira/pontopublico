/**
 * O2-08b (Onda 2) — Extrato de arrecadação de uma receita (Lei 4.320): COMPORTAMENTO.
 *
 * getRevenueCollections lista as arrecadações de UMA receita, em ordem cronológica, com o
 * total. É isolado por revenue_id — não vaza a arrecadação de outra receita.
 *
 * Mutação: remover o filtro revenue_id (vazar de outra receita) derruba; remover a
 * ordenação por data também derruba.
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

const dir = mkdtempSync(join(tmpdir(), "revenue-collections-test-"));

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

let natSeq = 0;
async function seedRevenue() {
  natSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.budget_revenues
       (id, tenant_id, exercicio, natureza_receita, fonte_recurso, descricao, valor_previsto)
     values ($1,$2,2026,$3,'1500','Receita',100000)`,
    [id, tenantId, `1.1.1.${natSeq}`],
  );
  return id;
}

async function seedCollection(revenueId, data, valor) {
  await db.query(
    `insert into public.revenue_collections
       (id, tenant_id, revenue_id, data_arrecadacao, valor, historico)
     values ($1,$2,$3,$4,$5,'arrecadacao')`,
    [randomUUID(), tenantId, revenueId, data, valor],
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
  Object.assign(fn, await bundle("src/lib/revenue.functions.ts", "rev.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("extrato de uma receita: cronológico, isolado e com total", async () => {
  const a = await seedRevenue();
  const b = await seedRevenue();
  // Insere fora de ordem cronológica de propósito.
  await seedCollection(a, "2026-03-10", 300);
  await seedCollection(a, "2026-02-01", 700);
  // Arrecadação da outra receita: não pode aparecer no extrato de A.
  await seedCollection(b, "2026-02-15", 999);

  const r = await fn.getRevenueCollections({
    data: { tenant_id: tenantId, revenue_id: a },
    context: ctx(),
  });

  assert.equal(r.collections.length, 2);
  // Ordem cronológica: 2026-02-01 antes de 2026-03-10.
  assert.equal(r.collections[0].data_arrecadacao, "2026-02-01");
  assert.equal(r.collections[1].data_arrecadacao, "2026-03-10");
  assert.equal(r.total, 1000); // 700 + 300, sem os 999 da outra receita
});
