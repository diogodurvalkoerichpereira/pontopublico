/**
 * O3-18 (Onda 3 — Materiais) — razão (kardex) de material: COMPORTAMENTO.
 *
 * getMaterialLedger relê as movimentações do item em ordem cronológica e recompõe o
 * saldo em quantidade linha a linha (entrada soma, saída subtrai). Grava 3 movimentos
 * pelo handler real e confere o saldo corrente de cada linha e o saldo final, que deve
 * bater com o saldo do próprio item.
 *
 * Mutação: inverter o sinal da saída no saldo corrente (ou zerar o acúmulo a cada linha)
 * derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "material-ledger-test-"));

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
  Object.assign(fn, await bundle("src/lib/materials.functions.ts", "mat.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("razão recompõe o saldo corrente e fecha no saldo do item", async () => {
  const itemId = randomUUID();
  await db.query(
    `insert into public.material_items
       (id, tenant_id, codigo, nome, unidade, categoria)
     values ($1,$2,'MAT-1','Papel','rm','consumo')`,
    [itemId, tenantId],
  );
  const mov = (tipo, quantidade, valor_unitario, data_movimento) =>
    fn.recordMaterialMovement({
      data: {
        tenant_id: tenantId,
        item_id: itemId,
        tipo,
        quantidade,
        valor_unitario,
        data_movimento,
        historico: "Movimento",
      },
      context: ctx(),
    });

  await mov("entrada", 100, 10, "2026-01-01");
  await mov("saida", 30, 0, "2026-01-05");
  await mov("entrada", 20, 12, "2026-01-10");

  const r = await fn.getMaterialLedger({
    data: { tenant_id: tenantId, item_id: itemId },
    context: ctx(),
  });

  assert.equal(r.movimentos.length, 3);
  // Saldo corrente: 100 → 70 → 90.
  assert.deepEqual(
    r.movimentos.map((m) => m.saldo_quantidade),
    [100, 70, 90],
  );
  // Fecha no saldo do próprio item.
  assert.equal(r.movimentos.at(-1).saldo_quantidade, r.item.saldo_quantidade);
  assert.equal(r.item.saldo_quantidade, 90);
});
