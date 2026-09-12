/**
 * O3-03b (Onda 3 — Patrimônio) — resumo do patrimônio: COMPORTAMENTO.
 *
 * getPatrimonySummary consolida os bens ativos: valor de aquisição, depreciação acumulada
 * e o valor líquido contábil (aquisição − depreciação). Bem baixado não entra no acervo
 * líquido. Seeda bens ativos e um baixado e confere os totais.
 *
 * Mutação: computar o líquido como aquisição (ignorar a depreciação), ou incluir o
 * baixado nos totais ativos, derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "patrimony-summary-test-"));

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

let seq = 0;
async function seedAsset({ aquisicao, depreciacao = 0, status = "ativo" }) {
  seq += 1;
  await db.query(
    `insert into public.patrimony_assets
       (id, tenant_id, tombamento, descricao, valor_aquisicao, valor_residual,
        vida_util_meses, meses_depreciados, depreciacao_acumulada, data_aquisicao, status)
     values ($1,$2,$3,'Bem',$4,0,60,0,$5,'2026-01-01',$6)`,
    [randomUUID(), tenantId, `T-${seq}`, aquisicao, depreciacao, status],
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
  Object.assign(fn, await bundle("src/lib/assets.functions.ts", "assets.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("resume ativos: líquido = aquisição − depreciação, ignora baixado", async () => {
  // Ativo 1: aquisição 1000, deprec 200 → líquido 800.
  await seedAsset({ aquisicao: 1000, depreciacao: 200 });
  // Ativo 2: aquisição 500, deprec 100 → líquido 400.
  await seedAsset({ aquisicao: 500, depreciacao: 100 });
  // Baixado: não entra nos totais ativos.
  await seedAsset({ aquisicao: 9000, depreciacao: 1000, status: "baixado" });

  const r = await fn.getPatrimonySummary({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  assert.equal(r.ativos, 2);
  assert.equal(r.baixados, 1);
  assert.equal(r.valorAquisicao, 1500);
  assert.equal(r.depreciacaoAcumulada, 300);
  // Líquido = 1500 − 300 = 1200 (não 1500, e sem o baixado).
  assert.equal(r.valorLiquido, 1200);
});
