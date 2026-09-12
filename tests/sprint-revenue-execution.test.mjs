/**
 * O2-14 (Onda 2) — execução da receita por natureza: COMPORTAMENTO.
 *
 * getRevenueExecution agrupa por natureza o previsto/arrecadado e calcula o a
 * arrecadar (nunca negativo). Confere o agrupamento, os totais e o piso zero.
 *
 * Mutação: permitir a_arrecadar negativo (sem o Math.max) derruba.
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

const dir = mkdtempSync(join(tmpdir(), "revenue-exec-test-"));

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
  `const PERMS = ["budget.read","budget.manage"];
   export async function loadTenantAccess() { return { permissions: PERMS }; }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }`,
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

let fonteSeq = 0;
async function seedRevenue(natureza, previsto, arrecadado) {
  fonteSeq += 1;
  await db.query(
    `insert into public.budget_revenues
       (id, tenant_id, exercicio, natureza_receita, fonte_recurso, descricao,
        valor_previsto, valor_arrecadado)
     values ($1,$2,2026,$3,$4,'Receita',$5,$6)`,
    [randomUUID(), tenantId, natureza, `F${fonteSeq}`, previsto, arrecadado],
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
  Object.assign(
    fn,
    await bundle("src/lib/revenue-execution.functions.ts", "re.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("agrupa por natureza e calcula a arrecadar (piso zero)", async () => {
  await seedRevenue("1.1.1", 600, 500);
  await seedRevenue("1.1.1", 400, 100); // mesma natureza soma: 1000 / 600
  await seedRevenue("1.2.1", 200, 300); // arrecadado > previsto → a_arrecadar 0

  const r = await fn.getRevenueExecution({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  assert.equal(r.naturezas.length, 2);
  const n1 = r.naturezas.find((n) => n.natureza_receita === "1.1.1");
  assert.equal(n1.previsto, 1000);
  assert.equal(n1.arrecadado, 600);
  assert.equal(n1.a_arrecadar, 400);
  const n2 = r.naturezas.find((n) => n.natureza_receita === "1.2.1");
  assert.equal(n2.a_arrecadar, 0); // não fica negativo

  assert.equal(r.totais.previsto, 1200);
  assert.equal(r.totais.arrecadado, 900);
  assert.equal(r.totais.a_arrecadar, 300);
});
