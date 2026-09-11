/**
 * O2-09 (Onda 2) — restos a pagar: COMPORTAMENTO (ponta a ponta).
 *
 * inscribeRestosAPagar inscreve os empenhos não pagos do exercício: liquidados →
 * processados, empenhados → não processados; pago/anulado não inscreve. É
 * idempotente. payRestoAPagar quita o resto e o empenho de origem.
 *
 * Mutação: inscrever também empenhos pagos derruba a contagem.
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
let numeroSeq = 0;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "restos-test-"));

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

async function seedCommitment(status, valor, exercicio = 2025) {
  const id = randomUUID();
  numeroSeq += 1;
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho, credor,
        historico, valor, status)
     values ($1,$2,$3,$4,$5,'2025-06-01','Credor X','Empenho',$6,$7)`,
    [id, tenantId, appropriationId, exercicio, numeroSeq, valor, status],
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
  appropriationId = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado)
     values ($1,$2,2025,'01','04','122','0001','2001','3.3.90.30','1500',1000000)`,
    [appropriationId, tenantId],
  );
  Object.assign(
    fn,
    await bundle("src/lib/restos-a-pagar.functions.ts", "r.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("inscreve processados/nao processados, ignora pago/anulado, idempotente", async () => {
  await seedCommitment("liquidado", 100); // processado
  await seedCommitment("liquidado", 50); // processado
  await seedCommitment("empenhado", 30); // nao processado
  await seedCommitment("pago", 200); // ignorado
  await seedCommitment("anulado", 70); // ignorado

  const r = await fn.inscribeRestosAPagar({
    data: { tenant_id: tenantId, exercicio: 2025, inscrito_em: "2025-12-31" },
    context: ctx(),
  });
  assert.equal(r.inscritos, 3);
  assert.equal(r.processados, 2);
  assert.equal(r.nao_processados, 1);
  assert.equal(r.valor_total, 180);

  // Reexecutar não duplica (idempotente).
  const again = await fn.inscribeRestosAPagar({
    data: { tenant_id: tenantId, exercicio: 2025, inscrito_em: "2025-12-31" },
    context: ctx(),
  });
  assert.equal(again.inscritos, 0);

  const total = (
    await db.query(
      "select count(*)::int as n from public.restos_a_pagar where tenant_id=$1",
      [tenantId],
    )
  ).rows[0].n;
  assert.equal(total, 3);
});

test("pagar resto quita o empenho de origem", async () => {
  const cid = await seedCommitment("liquidado", 500, 2024);
  await fn.inscribeRestosAPagar({
    data: { tenant_id: tenantId, exercicio: 2024, inscrito_em: "2024-12-31" },
    context: ctx(),
  });
  const resto = (
    await db.query(
      "select id from public.restos_a_pagar where commitment_id=$1",
      [cid],
    )
  ).rows[0];
  const r = await fn.payRestoAPagar({
    data: {
      tenant_id: tenantId,
      resto_id: resto.id,
      data_pagamento: "2025-03-01",
    },
    context: ctx(),
  });
  assert.equal(r.status, "pago");
  const commitment = (
    await db.query("select status from public.budget_commitments where id=$1", [
      cid,
    ])
  ).rows[0];
  assert.equal(commitment.status, "pago");

  // Não paga de novo.
  await assert.rejects(
    fn.payRestoAPagar({
      data: {
        tenant_id: tenantId,
        resto_id: resto.id,
        data_pagamento: "2025-03-02",
      },
      context: ctx(),
    }),
    /inscrito/,
  );
});
