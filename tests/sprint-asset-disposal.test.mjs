/**
 * O3-11 (Onda 3) — baixa / alienação de bem patrimonial: COMPORTAMENTO.
 *
 * disposeAsset apura o resultado da baixa = valor de alienação − valor líquido
 * contábil (aquisição − depreciação acumulada): ganho se positivo, perda se negativo.
 * Só um bem ativo baixa; a baixa é definitiva. Confere o ganho, a perda, o
 * desfazimento sem alienação e a recusa de baixar duas vezes.
 *
 * Mutação: inverter para líquido − alienação no resultado derruba o sinal.
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

const dir = mkdtempSync(join(tmpdir(), "asset-disposal-test-"));

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

let tombSeq = 0;
async function seedAsset(aquisicao, depreciacao) {
  tombSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.patrimony_assets
       (id, tenant_id, tombamento, descricao, valor_aquisicao, valor_residual,
        vida_util_meses, data_aquisicao, meses_depreciados, depreciacao_acumulada)
     values ($1,$2,$3,'Bem',$4,0,60,'2024-01-01',12,$5)`,
    [id, tenantId, `TOMB-${tombSeq}`, aquisicao, depreciacao],
  );
  return id;
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
  Object.assign(fn, await bundle("src/lib/assets.functions.ts", "as.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("alienação acima do valor líquido gera ganho; baixa é definitiva", async () => {
  const asset = await seedAsset(10000, 3000); // líquido 7000
  const r = await fn.disposeAsset({
    data: {
      tenant_id: tenantId,
      asset_id: asset,
      data_baixa: "2026-05-10",
      motivo: "Alienacao em leilao",
      valor_alienacao: 8000,
    },
    context: ctx(),
  });
  assert.equal(r.valor_liquido, 7000);
  assert.equal(r.resultado, 1000); // ganho

  const row = (
    await db.query(
      "select status, resultado_baixa::text from public.patrimony_assets where id=$1",
      [asset],
    )
  ).rows[0];
  assert.equal(row.status, "baixado");
  assert.equal(row.resultado_baixa, "1000.00");

  // Não baixa de novo.
  await assert.rejects(
    fn.disposeAsset({
      data: {
        tenant_id: tenantId,
        asset_id: asset,
        data_baixa: "2026-06-01",
        motivo: "Tentativa dupla",
        valor_alienacao: 100,
      },
      context: ctx(),
    }),
    /baixado/i,
  );
});

test("alienação abaixo do líquido gera perda; desfazimento sem venda perde o líquido", async () => {
  const a1 = await seedAsset(5000, 0); // líquido 5000
  const r1 = await fn.disposeAsset({
    data: {
      tenant_id: tenantId,
      asset_id: a1,
      data_baixa: "2026-05-10",
      motivo: "Venda abaixo do valor",
      valor_alienacao: 2000,
    },
    context: ctx(),
  });
  assert.equal(r1.resultado, -3000); // perda

  const a2 = await seedAsset(4000, 1000); // líquido 3000
  const r2 = await fn.disposeAsset({
    data: {
      tenant_id: tenantId,
      asset_id: a2,
      data_baixa: "2026-05-10",
      motivo: "Desfazimento por inservibilidade",
    },
    context: ctx(),
  });
  assert.equal(r2.valor_liquido, 3000);
  assert.equal(r2.resultado, -3000); // sem alienação, perde o líquido inteiro
});
