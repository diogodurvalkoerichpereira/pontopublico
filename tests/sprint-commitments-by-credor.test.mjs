/**
 * O2-17 (Onda 2) — posição de empenhos por credor: COMPORTAMENTO.
 *
 * getCommitmentsByCredor agrupa por credor o empenhado (não anulado) e o estágio da
 * despesa: a liquidar (empenhado), a pagar (liquidado), pago. Empenho anulado não
 * entra; credor com todos os empenhos anulados não aparece.
 *
 * Mutação: incluir 'anulado' no empenhado, ou trocar o estágio de a_pagar
 * (liquidado) por empenhado, derruba.
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
let appropriationId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "by-credor-test-"));

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
const acctStub = join(dir, "acct.mjs");
writeFileSync(
  acctStub,
  `export async function contabilizarEvento() { return null; }
   export async function postEntry() { return { id: "x", valor: 0 }; }`,
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
        [/(^|\/)accounting\.(functions|server)$/, acctStub],
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

let numeroSeq = 0;
async function seedCommitment(credor, valor, status) {
  numeroSeq += 1;
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho,
        tipo, credor, historico, valor, status)
     values ($1,$2,$3,2026,$4,'2026-02-01','ordinario',$5,'Empenho',$6,$7)`,
    [randomUUID(), tenantId, appropriationId, numeroSeq, credor, valor, status],
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
  appropriationId = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado, valor_empenhado)
     values ($1,$2,2026,'01','04','122','0001','2001','3.3.90.30','01',500000,0)`,
    [appropriationId, tenantId],
  );
  Object.assign(fn, await bundle("src/lib/budget.functions.ts", "bg.mjs"));

  // Fornecedor A: 1000 empenhado, 500 liquidado (a pagar), 300 pago; 700 anulado (não conta).
  await seedCommitment("Fornecedor A", 1000, "empenhado");
  await seedCommitment("Fornecedor A", 500, "liquidado");
  await seedCommitment("Fornecedor A", 300, "pago");
  await seedCommitment("Fornecedor A", 700, "anulado");
  // Fornecedor B: 200 liquidado (a pagar).
  await seedCommitment("Fornecedor B", 200, "liquidado");
  // Fornecedor C: só anulado -> não aparece.
  await seedCommitment("Fornecedor C", 999, "anulado");
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("posição por credor: estágios corretos, anulado fora, credor só-anulado omitido", async () => {
  const r = await fn.getCommitmentsByCredor({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });

  // C (só anulado) não entra; A e B sim.
  assert.equal(r.credores.length, 2);
  assert.equal(
    r.credores.some((c) => c.credor === "Fornecedor C"),
    false,
  );

  const a = r.credores.find((c) => c.credor === "Fornecedor A");
  assert.equal(a.qtd, 3); // anulado não conta
  assert.equal(a.empenhado, 1800); // 1000+500+300 (sem os 700 anulados)
  assert.equal(a.a_liquidar, 1000);
  assert.equal(a.a_pagar, 500);
  assert.equal(a.pago, 300);

  const b = r.credores.find((c) => c.credor === "Fornecedor B");
  assert.equal(b.a_pagar, 200);

  // Ordena por a_pagar desc: A (500) antes de B (200).
  assert.equal(r.credores[0].credor, "Fornecedor A");

  // Totais somam os credores listados.
  assert.equal(r.totais.empenhado, 2000); // 1800 + 200
  assert.equal(r.totais.a_pagar, 700); // 500 + 200
  assert.equal(r.totais.pago, 300);
});
