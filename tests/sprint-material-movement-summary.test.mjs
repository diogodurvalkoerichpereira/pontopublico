/**
 * O3-02b (Onda 3 — Materiais) — consolidação de movimentação por período: COMPORTAMENTO.
 *
 * getMaterialMovementSummary soma entradas e saídas (quantidade e valor = qtd × valor
 * unitário) das movimentações no intervalo [from, to]. Movimentos fora do período não
 * entram. Confere os totais por tipo e o recorte por data.
 *
 * Mutação: trocar o tipo somado (entrada↔saída), ou ignorar o filtro de período, derruba
 * o teste.
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

const dir = mkdtempSync(join(tmpdir(), "material-mov-summary-test-"));

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
let itemId;
async function seedMovement({ tipo, quantidade, valor_unitario, data }) {
  seq += 1;
  await db.query(
    `insert into public.material_movements
       (id, tenant_id, item_id, tipo, quantidade, valor_unitario,
        data_movimento, historico)
     values ($1,$2,$3,$4,$5,$6,$7,'Mov')`,
    [randomUUID(), tenantId, itemId, tipo, quantidade, valor_unitario, data],
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
  itemId = randomUUID();
  await db.query(
    `insert into public.material_items
       (id, tenant_id, codigo, nome, unidade, categoria)
     values ($1,$2,'MAT-1','Papel','rm','consumo')`,
    [itemId, tenantId],
  );
  Object.assign(fn, await bundle("src/lib/materials.functions.ts", "mat.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("consolida entradas e saídas do período, ignora fora do intervalo", async () => {
  // Dentro do período (março).
  await seedMovement({
    tipo: "entrada",
    quantidade: 100,
    valor_unitario: 10,
    data: "2026-03-05",
  }); // valor 1000
  await seedMovement({
    tipo: "entrada",
    quantidade: 50,
    valor_unitario: 8,
    data: "2026-03-20",
  }); // valor 400
  await seedMovement({
    tipo: "saida",
    quantidade: 30,
    valor_unitario: 10,
    data: "2026-03-25",
  }); // valor 300
  // Fora do período (fevereiro e abril) — não entram.
  await seedMovement({
    tipo: "entrada",
    quantidade: 999,
    valor_unitario: 10,
    data: "2026-02-15",
  });
  await seedMovement({
    tipo: "saida",
    quantidade: 999,
    valor_unitario: 10,
    data: "2026-04-02",
  });

  const r = await fn.getMaterialMovementSummary({
    data: { tenant_id: tenantId, from: "2026-03-01", to: "2026-03-31" },
    context: ctx(),
  });

  assert.equal(r.entradas.movimentos, 2);
  assert.equal(r.entradas.quantidade, 150);
  assert.equal(r.entradas.valor, 1400); // 1000 + 400

  assert.equal(r.saidas.movimentos, 1);
  assert.equal(r.saidas.quantidade, 30);
  assert.equal(r.saidas.valor, 300);
});
