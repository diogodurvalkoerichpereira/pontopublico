/**
 * O3-02 (Onda 3) — almoxarifado: COMPORTAMENTO (ponta a ponta).
 *
 * recordMaterialMovement: entrada soma ao estoque, saída subtrai e nunca excede o
 * saldo (custo médio). getMaterialItems lê o saldo. Confere o saldo e a recusa da
 * saída acima do estoque.
 *
 * Mutação: não subtrair na saída, ou remover a checagem de saldo, derruba.
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
let itemId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "materials-test-"));

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
  Object.assign(fn, await bundle("src/lib/materials.functions.ts", "m.mjs"));
  itemId = (
    await fn.saveMaterialItem({
      data: {
        tenant_id: tenantId,
        codigo: "CAN-001",
        nome: "Caneta azul",
        unidade: "UN",
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

const mov = (tipo, quantidade, valor_unitario) =>
  fn.recordMaterialMovement({
    data: {
      tenant_id: tenantId,
      item_id: itemId,
      tipo,
      quantidade,
      valor_unitario,
      data_movimento: "2026-03-10",
      historico: `${tipo} de material`,
    },
    context: ctx(),
  });
async function saldo() {
  const ws = await fn.getMaterialItems({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  const it = ws.items.find((i) => i.id === itemId);
  return {
    qtd: Number(it.saldo_quantidade),
    valor: Number(it.saldo_valor),
  };
}

test("entrada soma; saída subtrai a custo médio", async () => {
  await mov("entrada", 100, 2); // +100 un, +200,00
  let s = await saldo();
  assert.equal(s.qtd, 100);
  assert.equal(s.valor, 200);
  await mov("saida", 40, 0); // custo medio 2,00 -> -80,00
  s = await saldo();
  assert.equal(s.qtd, 60);
  assert.equal(s.valor, 120);
});

test("saída acima do saldo é recusada", async () => {
  await assert.rejects(mov("saida", 1000, 0), /excede o saldo/);
});
