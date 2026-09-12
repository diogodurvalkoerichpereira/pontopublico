/**
 * O3-02c (Onda 3 — Materiais) — ajuste de inventário (acerto físico): COMPORTAMENTO.
 *
 * adjustMaterialInventory concilia o saldo do sistema à quantidade contada: apura a
 * diferença, registra entrada (falta no sistema) ou saída (sobra) ao custo médio, e o
 * saldo passa a ser exatamente o contado. Sem diferença, recusa.
 *
 * Mutação: usar 'entrada' quando sobra (inverter o sinal da diferença) derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "material-adjust-test-"));

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
async function seedItem({ qtd, valor }) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.material_items
       (id, tenant_id, codigo, nome, unidade, categoria, saldo_quantidade, saldo_valor)
     values ($1,$2,$3,'Item','un','consumo',$4,$5)`,
    [id, tenantId, `MAT-${seq}`, qtd, valor],
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

const adjust = (item_id, quantidade_contada) =>
  fn.adjustMaterialInventory({
    data: {
      tenant_id: tenantId,
      item_id,
      quantidade_contada,
      data_ajuste: "2026-03-01",
      historico: "Contagem trimestral",
    },
    context: ctx(),
  });
const saldoOf = async (id) => {
  const r = (
    await db.query(
      "select saldo_quantidade::text q, saldo_valor::text v from public.material_items where id=$1",
      [id],
    )
  ).rows[0];
  return { q: Number(r.q), v: Number(r.v) };
};

test("sobra no sistema → saída de ajuste; falta → entrada; sem diferença recusa", async () => {
  // Saldo 100 un / R$ 1000 (custo médio 10). Contagem física = 90 → sobra 10 no sistema.
  const item = await seedItem({ qtd: 100, valor: 1000 });
  const r = await adjust(item, 90);
  assert.equal(r.tipo, "saida");
  assert.equal(r.diferenca, -10);
  const s = await saldoOf(item);
  assert.equal(s.q, 90); // saldo passa a ser o contado
  assert.equal(s.v, 900); // 1000 − 10×10

  // Contagem física = 95 (falta 5 no sistema) → entrada de ajuste.
  const r2 = await adjust(item, 95);
  assert.equal(r2.tipo, "entrada");
  assert.equal(r2.diferenca, 5);
  assert.equal((await saldoOf(item)).q, 95);

  // Sem diferença → recusa.
  await assert.rejects(adjust(item, 95), /nada a ajustar/i);
});
