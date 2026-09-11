/**
 * O2-22 (Onda 2) — crédito adicional por excesso de arrecadação (Lei 4.320 art. 43):
 * COMPORTAMENTO.
 *
 * openSupplementaryCredit suplementa a dotação de destino lastreado no excesso de
 * arrecadação da fonte (arrecadado − previsto), nunca acima do excesso ainda não
 * utilizado. Confere a suplementação, o consumo do excesso e o teto.
 *
 * Mutação: inverter o teto (valor > disponível → valor < disponível) derruba o teste.
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
let destinoId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "supp-credit-test-"));

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
  destinoId = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado, valor_empenhado)
     values ($1,$2,2026,'01','04','122','0001','2001','3.3.90.30','01',1000,0)`,
    [destinoId, tenantId],
  );
  // Receita da fonte '01': previsto 1000, arrecadado 1500 → excesso 500.
  await db.query(
    `insert into public.budget_revenues
       (id, tenant_id, exercicio, natureza_receita, fonte_recurso, descricao,
        valor_previsto, valor_arrecadado)
     values ($1,$2,2026,'1.1.1','01','Receita',1000,1500)`,
    [randomUUID(), tenantId],
  );
  Object.assign(
    fn,
    await bundle("src/lib/supplementary-credit.functions.ts", "sc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const open = (valor) =>
  fn.openSupplementaryCredit({
    data: {
      tenant_id: tenantId,
      destino_id: destinoId,
      fonte_recurso: "01",
      valor,
      data_referencia: "2026-06-01",
      justificativa: "Excesso de arrecadacao do IPTU",
    },
    context: ctx(),
  });

test("suplementa até o excesso de arrecadação; acima do disponível recusa", async () => {
  // Excesso 500: crédito de 400 é aceito; sobra 100.
  const r1 = await open(400);
  assert.equal(r1.valor, 400);
  assert.equal(r1.excesso_disponivel, 100);

  // Dotação suplementada: 1000 + 400 = 1400.
  const dot = (
    await db.query(
      "select valor_orcado::text from public.budget_appropriations where id=$1",
      [destinoId],
    )
  ).rows[0];
  assert.equal(dot.valor_orcado, "1400.00");

  // Novo crédito de 200 excede o disponível (100): recusa.
  await assert.rejects(open(200), /excesso de arrecadação/i);

  // Crédito de 100 fecha o excesso.
  const r2 = await open(100);
  assert.equal(r2.excesso_disponivel, 0);
});
