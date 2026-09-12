/**
 * O3-03c (Onda 3) — Rotina de depreciação em lote (NBC TSP): COMPORTAMENTO.
 *
 * depreciateAllAssets deprecia, num único ato, todos os bens ATIVOS com vida útil restante,
 * pela mesma fórmula linear da depreciação avulsa. Bem baixado ou já totalmente depreciado
 * é ignorado; a acumulada nunca passa da base depreciável (aquisição − residual).
 *
 * Mutação: incluir bens não-ativos (remover o filtro status='ativo') faz depreciar um bem
 * baixado — o teste derruba.
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

const dir = mkdtempSync(join(tmpdir(), "depreciate-all-test-"));

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
async function seedAsset({
  aquisicao,
  residual = 0,
  vida = 60,
  meses = 0,
  acumulada = 0,
  status = "ativo",
}) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.patrimony_assets
       (id, tenant_id, tombamento, descricao, valor_aquisicao, valor_residual,
        vida_util_meses, meses_depreciados, depreciacao_acumulada, data_aquisicao, status)
     values ($1,$2,$3,'Bem',$4,$5,$6,$7,$8,'2026-01-01',$9)`,
    [
      id,
      tenantId,
      `TD-${seq}`,
      aquisicao,
      residual,
      vida,
      meses,
      acumulada,
      status,
    ],
  );
  return id;
}

const acumOf = async (id) =>
  Number(
    (
      await db.query(
        "select depreciacao_acumulada::text d from public.patrimony_assets where id=$1",
        [id],
      )
    ).rows[0].d,
  );
const mesesOf = async (id) =>
  (
    await db.query(
      "select meses_depreciados m from public.patrimony_assets where id=$1",
      [id],
    )
  ).rows[0].m;

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

test("deprecia 1 mês em lote os ativos; ignora baixado e totalmente depreciado", async () => {
  // Ativo A: 12000, vida 60m → cota 200/mês.
  const a = await seedAsset({ aquisicao: 12000, vida: 60 });
  // Ativo B: 6000, vida 60m → cota 100/mês, já com 10 meses.
  const b = await seedAsset({
    aquisicao: 6000,
    vida: 60,
    meses: 10,
    acumulada: 1000,
  });
  // Bem baixado: não deprecia.
  const baixado = await seedAsset({
    aquisicao: 5000,
    vida: 60,
    status: "baixado",
  });
  // Bem já totalmente depreciado: ignorado.
  const cheio = await seedAsset({
    aquisicao: 3000,
    vida: 12,
    meses: 12,
    acumulada: 3000,
  });

  const r = await fn.depreciateAllAssets({
    data: { tenant_id: tenantId, meses: 1 },
    context: ctx(),
  });

  // Só A e B foram depreciados; cota total = 200 + 100 = 300.
  assert.equal(r.depreciados, 2);
  assert.equal(r.total_cota, 300);
  assert.equal(await acumOf(a), 200);
  assert.equal(await mesesOf(a), 1);
  assert.equal(await acumOf(b), 1100);
  assert.equal(await mesesOf(b), 11);
  // Baixado e cheio intactos.
  assert.equal(await acumOf(baixado), 0);
  assert.equal(await acumOf(cheio), 3000);
  assert.equal(await mesesOf(cheio), 12);
});
