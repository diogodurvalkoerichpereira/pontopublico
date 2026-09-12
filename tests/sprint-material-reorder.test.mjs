/**
 * O3-02c (Onda 3) — Alerta de reposição do almoxarifado (ponto de pedido): COMPORTAMENTO.
 *
 * getMaterialReorderAlerts lista os itens ATIVOS com estoque mínimo > 0 cujo saldo caiu ao
 * mínimo ou abaixo, com o faltante (mínimo − saldo). Item sem mínimo (0), com saldo acima
 * do mínimo, ou inativo, não alerta.
 *
 * Mutação: trocar a comparação do saldo (<= por <) deixa de alertar o item exatamente no
 * mínimo; remover o filtro estoque_minimo > 0 alerta itens sem controle. Ambas derrubam.
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

const dir = mkdtempSync(join(tmpdir(), "material-reorder-test-"));

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
  `const PERMS = ["materials.read","materials.manage"];
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
async function seedItem({ saldo, minimo, status = "ativo" }) {
  seq += 1;
  const codigo = `MAT-${seq}`;
  await db.query(
    `insert into public.material_items
       (id, tenant_id, codigo, nome, unidade, categoria, saldo_quantidade,
        estoque_minimo, status)
     values ($1,$2,$3,'Item','un','consumo',$4,$5,$6)`,
    [randomUUID(), tenantId, codigo, saldo, minimo, status],
  );
  return codigo;
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
  Object.assign(fn, await bundle("src/lib/materials.functions.ts", "mat.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("alerta só itens ativos, com mínimo, no limite ou abaixo", async () => {
  const abaixo = await seedItem({ saldo: 2, minimo: 10 }); // falta 8
  const noLimite = await seedItem({ saldo: 5, minimo: 5 }); // falta 0, no limite
  await seedItem({ saldo: 20, minimo: 5 }); // acima do mínimo: não alerta
  await seedItem({ saldo: 0, minimo: 0 }); // sem controle de mínimo: não alerta
  await seedItem({ saldo: 1, minimo: 10, status: "inativo" }); // inativo: não alerta

  const r = await fn.getMaterialReorderAlerts({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  assert.equal(r.itens.length, 2);
  // Ordenado pelo maior faltante primeiro.
  assert.equal(r.itens[0].codigo, abaixo);
  assert.equal(r.itens[0].faltante, 8);
  assert.equal(r.itens[1].codigo, noLimite);
  assert.equal(r.itens[1].faltante, 0);
});
