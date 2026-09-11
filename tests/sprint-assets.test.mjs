/**
 * O3-03 (Onda 3) — patrimônio e depreciação (NBC TSP): COMPORTAMENTO.
 *
 * depreciateAsset deprecia linear; a acumulada nunca passa da base depreciável
 * (aquisição − residual) e respeita a vida útil. Confere a depreciação e o teto.
 *
 * Mutação: não capar na base depreciável (depreciar abaixo do residual) derruba.
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
let assetId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "assets-test-"));

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
  `const PERMS = ["assets.read","assets.manage"];
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
  Object.assign(fn, await bundle("src/lib/assets.functions.ts", "a.mjs"));
  // Aquisicao 12000, residual 0, vida util 12 meses -> cota 1000/mes.
  assetId = (
    await fn.saveAsset({
      data: {
        tenant_id: tenantId,
        tombamento: "TOMB-001",
        descricao: "Computador",
        valor_aquisicao: 12000,
        valor_residual: 0,
        vida_util_meses: 12,
        data_aquisicao: "2026-01-01",
        status: "ativo",
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

const depreciate = (meses) =>
  fn.depreciateAsset({
    data: { tenant_id: tenantId, asset_id: assetId, meses },
    context: ctx(),
  });

test("depreciação linear acumula por mês", async () => {
  const r = await depreciate(3);
  assert.equal(r.meses_depreciados, 3);
  assert.equal(r.depreciacao_acumulada, 3000);
  assert.equal(r.valor_liquido, 9000);
});

test("a depreciação nunca ultrapassa a base depreciável (residual preservado)", async () => {
  // Ja depreciou 3 meses (3000). Pedir 100 meses: capa em 12000 (base), nao mais.
  const r = await depreciate(100);
  assert.equal(r.depreciacao_acumulada, 12000);
  assert.equal(r.valor_liquido, 0);
  assert.equal(r.meses_depreciados, 12, "respeita a vida util de 12 meses");
});

test("bem com valor residual não deprecia abaixo do residual", async () => {
  const outro = (
    await fn.saveAsset({
      data: {
        tenant_id: tenantId,
        tombamento: "TOMB-002",
        descricao: "Veiculo",
        valor_aquisicao: 100000,
        valor_residual: 20000,
        vida_util_meses: 10,
        data_aquisicao: "2026-01-01",
        status: "ativo",
      },
      context: ctx(),
    })
  ).id;
  const r = await fn.depreciateAsset({
    data: { tenant_id: tenantId, asset_id: outro, meses: 50 },
    context: ctx(),
  });
  // base = 80000; acumulada capa em 80000; liquido = 100000 - 80000 = 20000 (residual).
  assert.equal(r.depreciacao_acumulada, 80000);
  assert.equal(r.valor_liquido, 20000);
});
