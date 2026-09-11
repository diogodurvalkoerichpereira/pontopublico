/**
 * O2-02 (Onda 2) — empenho contra dotação: teste de COMPORTAMENTO (ponta a ponta).
 *
 * createBudgetCommitment reserva o valor no saldo da dotação, atômico. Confere:
 *  - o empenho reduz o saldo (valor_empenhado sobe);
 *  - empenho acima do saldo é recusado;
 *  - a numeração é sequencial por exercício.
 *
 * Mutação: não somar ao valor_empenhado, ou remover a checagem de saldo, derruba.
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
let dotacaoId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "commitment-test-"));

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
  Object.assign(fn, await bundle("src/lib/budget.functions.ts", "b.mjs"));
  const created = await fn.saveBudgetAppropriation({
    data: {
      tenant_id: tenantId,
      exercicio: 2026,
      unidade_orcamentaria: "02.01",
      funcao: "04",
      subfuncao: "122",
      programa: "0001",
      acao: "2001",
      natureza_despesa: "3.1.90.11.00",
      fonte_recurso: "1.500.0000",
      valor_orcado: 100000,
      status: "ativa",
    },
    context: ctx(),
  });
  dotacaoId = created.id;
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

function empenhar(valor) {
  return fn.createBudgetCommitment({
    data: {
      tenant_id: tenantId,
      appropriation_id: dotacaoId,
      data_empenho: "2026-03-15",
      tipo: "ordinario",
      credor: "Fornecedor X",
      historico: "Aquisicao de material",
      valor,
    },
    context: ctx(),
  });
}

async function saldo() {
  const ws = await fn.getBudgetAppropriations({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  const row = ws.appropriations.find((a) => a.id === dotacaoId);
  return { empenhado: Number(row.valor_empenhado), saldo: Number(row.saldo) };
}

test("o empenho reserva o valor no saldo da dotação (numeração sequencial)", async () => {
  const a = await empenhar(60000);
  assert.equal(a.numero, 1);
  const s1 = await saldo();
  assert.equal(s1.empenhado, 60000);
  assert.equal(s1.saldo, 40000);

  const b = await empenhar(40000);
  assert.equal(b.numero, 2);
  const s2 = await saldo();
  assert.equal(s2.empenhado, 100000);
  assert.equal(s2.saldo, 0);

  const commitments = await fn.getBudgetCommitments({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  assert.equal(commitments.length, 2);
});

test("empenho acima do saldo é recusado", async () => {
  // Saldo já é 0 após o teste anterior.
  await assert.rejects(empenhar(1), /excede o saldo/);
});
