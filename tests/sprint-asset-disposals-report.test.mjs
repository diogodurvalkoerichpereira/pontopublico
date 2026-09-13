/**
 * O3-11b (Onda 5) — demonstrativo de baixas/alienações do exercício: COMPORTAMENTO.
 *
 * getAssetDisposals lista os bens baixados no período (por data de baixa) e consolida
 * valor líquido baixado, valor de alienação, ganhos, perdas e o resultado líquido — o
 * efeito das alienações nas variações patrimoniais (NBC TSP). Só entra baixa dentro do
 * intervalo; bem ativo não entra.
 *
 * Mutação: somar a perda nos ganhos (sem separar por sinal) derruba o resultado líquido.
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

const dir = mkdtempSync(join(tmpdir(), "asset-disposals-report-test-"));

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

const dispose = (id, data_baixa, valor_alienacao) =>
  fn.disposeAsset({
    data: {
      tenant_id: tenantId,
      asset_id: id,
      data_baixa,
      motivo: "Baixa",
      valor_alienacao,
    },
    context: ctx(),
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
  Object.assign(fn, await bundle("src/lib/assets.functions.ts", "as.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("consolida ganhos e perdas das baixas do período; resultado líquido é o saldo", async () => {
  // Ganho: líquido 7000, alienação 8000 → +1000.
  const ganho = await seedAsset(10000, 3000);
  await dispose(ganho, "2026-03-10", 8000);
  // Perda: líquido 5000, alienação 2000 → −3000.
  const perda = await seedAsset(5000, 0);
  await dispose(perda, "2026-04-20", 2000);
  // Fora do período: não entra.
  const fora = await seedAsset(4000, 1000);
  await dispose(fora, "2025-12-31", 0);
  // Ativo (não baixado): não entra.
  await seedAsset(9000, 0);

  const r = await fn.getAssetDisposals({
    data: { tenant_id: tenantId, from: "2026-01-01", to: "2026-12-31" },
    context: ctx(),
  });

  assert.equal(r.disposals.length, 2);
  assert.deepEqual(
    r.disposals.map((d) => [d.valor_liquido, d.resultado_baixa]),
    [
      [7000, 1000],
      [5000, -3000],
    ],
  );
  assert.equal(r.totais.valor_liquido, 12000);
  assert.equal(r.totais.valor_alienacao, 10000);
  assert.equal(r.totais.ganhos, 1000);
  assert.equal(r.totais.perdas, -3000);
  assert.equal(r.totais.resultado_liquido, -2000);
});
