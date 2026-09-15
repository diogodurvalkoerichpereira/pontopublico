/**
 * O2-08c (Onda 5) — estorno de arrecadação de receita: COMPORTAMENTO.
 *
 * reverseRevenueCollection marca a arrecadação como estornada (append-only, a linha fica) e
 * DECREMENTA o valor_arrecadado da receita pelo valor estornado; getRevenueCollections
 * exclui a estornada do total efetivo. Uma arrecadação já estornada não estorna de novo.
 *
 * Mutação: não decrementar o valor_arrecadado no estorno deixa a receita inflada — derruba.
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
let contaId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "revenue-reversal-test-"));

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

let natSeq = 0;
async function seedRevenue() {
  natSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.budget_revenues
       (id, tenant_id, exercicio, natureza_receita, fonte_recurso, descricao, valor_previsto)
     values ($1,$2,2026,$3,'1500','Receita',100000)`,
    [id, tenantId, `1.1.1.${natSeq}`],
  );
  return id;
}
const collect = (revenueId, valor) =>
  fn.recordRevenueCollection({
    data: {
      tenant_id: tenantId,
      revenue_id: revenueId,
      account_id: contaId,
      data_arrecadacao: "2026-03-10",
      valor,
      historico: "Arrecadacao",
    },
    context: ctx(),
  });
const reverse = (collectionId) =>
  fn.reverseRevenueCollection({
    data: {
      tenant_id: tenantId,
      collection_id: collectionId,
      motivo: "Lancamento em duplicidade",
    },
    context: ctx(),
  });
const arrecadadoDe = async (revenueId) =>
  Number(
    (
      await db.query(
        "select valor_arrecadado::text v from public.budget_revenues where id=$1",
        [revenueId],
      )
    ).rows[0].v,
  );

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
  // O4-18 — arrecadar credita uma conta de tesouraria: o teste precisa de uma.
  contaId = randomUUID();
  await db.query(
    `insert into public.treasury_accounts (id, tenant_id, nome, tipo, status)
     values ($1,$2,'Conta Unica','banco','ativa')`,
    [contaId, tenantId],
  );
  Object.assign(fn, await bundle("src/lib/revenue.functions.ts", "rev.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("estorno decrementa o arrecadado e sai do total; não estorna duas vezes", async () => {
  const rev = await seedRevenue();
  const c1 = await collect(rev, 700);
  await collect(rev, 300);
  assert.equal(await arrecadadoDe(rev), 1000);

  // Estorna a de 700 → arrecadado volta a 300.
  const r = await reverse(c1.id);
  assert.equal(r.valor, 700);
  assert.equal(await arrecadadoDe(rev), 300);

  // Extrato: a estornada fica listada, mas o total efetivo é 300.
  const ext = await fn.getRevenueCollections({
    data: { tenant_id: tenantId, revenue_id: rev },
    context: ctx(),
  });
  assert.equal(ext.collections.length, 2);
  assert.equal(ext.total, 300);
  assert.equal(ext.collections.find((c) => c.id === c1.id).estornada, true);

  // Não estorna de novo.
  await assert.rejects(reverse(c1.id), /já estornada/i);
});
