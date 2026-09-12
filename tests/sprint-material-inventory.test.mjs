/**
 * O3-17 (Onda 3 — Materiais) — inventário por categoria: COMPORTAMENTO.
 *
 * getMaterialInventory totaliza itens e saldos (quantidade/valor) agrupados por
 * categoria (consumo/permanente), com total geral, considerando apenas material
 * ativo. Confere os subtotais por categoria, o total geral e a exclusão de inativo.
 *
 * Mutação: somar só uma categoria no total geral, ou remover o filtro status='ativo'
 * (passando a contar o item inativo), derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "material-inventory-test-"));

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
async function seedItem({ categoria, qtd, valor, status = "ativo" }) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.material_items
       (id, tenant_id, codigo, nome, unidade, categoria,
        saldo_quantidade, saldo_valor, status)
     values ($1,$2,$3,'Item','un',$4,$5,$6,$7)`,
    [id, tenantId, `MAT-${seq}`, categoria, qtd, valor, status],
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
  Object.assign(fn, await bundle("src/lib/materials.functions.ts", "mat.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const inventory = () =>
  fn.getMaterialInventory({ data: { tenant_id: tenantId }, context: ctx() });

test("inventário agrupa por categoria com total geral e ignora inativo", async () => {
  // Consumo: 2 itens ativos, saldos 100.00 + 50.00 = 150.00; qtd 10 + 5 = 15.
  await seedItem({ categoria: "consumo", qtd: 10, valor: 100 });
  await seedItem({ categoria: "consumo", qtd: 5, valor: 50 });
  // Permanente: 1 item ativo, saldo 300.00; qtd 3.
  await seedItem({ categoria: "permanente", qtd: 3, valor: 300 });
  // Inativo permanente: NÃO entra no inventário.
  await seedItem({
    categoria: "permanente",
    qtd: 999,
    valor: 9999,
    status: "inativo",
  });

  const r = await inventory();
  const consumo = r.categorias.find((c) => c.categoria === "consumo");
  const permanente = r.categorias.find((c) => c.categoria === "permanente");

  assert.equal(consumo.itens, 2);
  assert.equal(consumo.saldo_quantidade, 15);
  assert.equal(consumo.saldo_valor, 150);

  assert.equal(permanente.itens, 1);
  assert.equal(permanente.saldo_quantidade, 3);
  assert.equal(permanente.saldo_valor, 300);

  // Total geral soma AS DUAS categorias (não só uma) e exclui o inativo.
  assert.equal(r.total.itens, 3);
  assert.equal(r.total.saldo_quantidade, 18);
  assert.equal(r.total.saldo_valor, 450);
});
