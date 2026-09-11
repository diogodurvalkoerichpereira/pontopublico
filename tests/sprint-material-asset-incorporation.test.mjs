/**
 * O3-19 (Onda 3) — incorporação de material permanente ao patrimônio: COMPORTAMENTO.
 *
 * incorporateMaterialAsset dá baixa da quantidade no almoxarifado a custo médio e cria o
 * bem patrimonial com valor de aquisição = custo médio × quantidade. Só material
 * 'permanente' com saldo suficiente incorpora. Confere o saldo baixado, o valor do bem e
 * as recusas (consumo, saldo insuficiente).
 *
 * Mutação: usar o saldo total em vez de custo médio × quantidade no valor do bem, ou
 * permitir incorporar material de consumo, derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "material-asset-test-"));

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
  `const PERMS = ["materials.read","materials.manage","assets.read","assets.manage"];
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
async function seedItem({ categoria, qtd, valor }) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.material_items
       (id, tenant_id, codigo, nome, unidade, categoria,
        saldo_quantidade, saldo_valor)
     values ($1,$2,$3,'Item','un',$4,$5,$6)`,
    [id, tenantId, `MAT-${seq}`, categoria, qtd, valor],
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
  Object.assign(fn, await bundle("src/lib/assets.functions.ts", "assets.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const incorporate = (extra) =>
  fn.incorporateMaterialAsset({
    data: {
      tenant_id: tenantId,
      vida_util_meses: 60,
      data_aquisicao: "2026-03-01",
      ...extra,
    },
    context: ctx(),
  });

test("incorpora material permanente: baixa a custo médio e cria o bem", async () => {
  // 10 un / R$ 1000 → custo médio 100.
  const item = await seedItem({
    categoria: "permanente",
    qtd: 10,
    valor: 1000,
  });

  const r = await incorporate({
    item_id: item,
    quantidade: 3,
    tombamento: "TOMB-1",
    descricao: "Notebook",
  });
  // Valor do bem = 100 × 3 = 300 (não o saldo total 1000).
  assert.equal(r.valor_aquisicao, 300);
  assert.equal(r.saldo_quantidade, 7);

  // Estoque baixado.
  const it = (
    await db.query(
      "select saldo_quantidade::text q, saldo_valor::text v from public.material_items where id=$1",
      [item],
    )
  ).rows[0];
  assert.equal(Number(it.q), 7);
  assert.equal(Number(it.v), 700);

  // Bem criado com o valor de aquisição correto.
  const asset = (
    await db.query(
      "select valor_aquisicao::text v, status from public.patrimony_assets where id=$1",
      [r.asset_id],
    )
  ).rows[0];
  assert.equal(Number(asset.v), 300);
  assert.equal(asset.status, "ativo");
});

test("recusa material de consumo e saldo insuficiente", async () => {
  const consumo = await seedItem({ categoria: "consumo", qtd: 5, valor: 500 });
  await assert.rejects(
    incorporate({ item_id: consumo, quantidade: 1, tombamento: "TOMB-C" }),
    /permanente/i,
  );

  const perm = await seedItem({ categoria: "permanente", qtd: 2, valor: 200 });
  await assert.rejects(
    incorporate({ item_id: perm, quantidade: 5, tombamento: "TOMB-X" }),
    /excede o saldo/i,
  );
});
