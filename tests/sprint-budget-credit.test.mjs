/**
 * O2-13 (Onda 2) — remanejamento de crédito (Lei 4.320): COMPORTAMENTO.
 *
 * transferBudgetCredit anula na origem e suplementa o destino; a origem nunca fica
 * abaixo do já empenhado. Confere o remanejamento válido e a recusa quando a
 * origem cairia abaixo do empenhado.
 *
 * Mutação: ignorar o piso do empenhado na origem derruba.
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

const dir = mkdtempSync(join(tmpdir(), "budget-credit-test-"));

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

async function seedDotacao(acao, orcado, empenhado, exercicio = 2026) {
  const id = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado,
        valor_empenhado)
     values ($1,$2,$3,'01','04','122','0001',$4,'3.3.90.30','1500',$5,$6)`,
    [id, tenantId, exercicio, acao, orcado, empenhado],
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
  Object.assign(
    fn,
    await bundle("src/lib/budget-credit.functions.ts", "bc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const transfer = (origem, destino, valor) =>
  fn.transferBudgetCredit({
    data: {
      tenant_id: tenantId,
      origem_id: origem,
      destino_id: destino,
      valor,
      data_referencia: "2026-06-01",
      justificativa: "Remanejamento por necessidade",
    },
    context: ctx(),
  });

test("remaneja crédito e respeita o piso do empenhado na origem", async () => {
  const origem = await seedDotacao("2001", 1000, 300); // saldo p/ remanejar: 700
  const destino = await seedDotacao("2002", 500, 0);

  const r = await transfer(origem, destino, 700);
  assert.equal(r.origem_orcado, 300);
  const o = (
    await db.query(
      "select valor_orcado::text from public.budget_appropriations where id=$1",
      [origem],
    )
  ).rows[0];
  const d = (
    await db.query(
      "select valor_orcado::text from public.budget_appropriations where id=$1",
      [destino],
    )
  ).rows[0];
  assert.equal(o.valor_orcado, "300.00"); // == empenhado (limite)
  assert.equal(d.valor_orcado, "1200.00"); // 500 + 700

  // Mais R$1 estouraria (origem cairia abaixo do empenhado 300).
  await assert.rejects(transfer(origem, destino, 1), /abaixo do empenhado/);
});

test("recusa remanejamento entre exercícios diferentes", async () => {
  const a = await seedDotacao("3001", 1000, 0, 2026);
  const b = await seedDotacao("3002", 0, 0, 2027);
  await assert.rejects(transfer(a, b, 100), /mesmo exercício/);
});
