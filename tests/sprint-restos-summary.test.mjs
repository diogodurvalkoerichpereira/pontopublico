/**
 * O2-09b (Onda 2) — Demonstrativo de restos a pagar (Lei 4.320): COMPORTAMENTO.
 *
 * getRestosAPagarSummary consolida os restos por situação (inscrito=a pagar, pago,
 * cancelado) e o saldo a pagar (status='inscrito') aberto por tipo (processado /
 * não-processado). Resto pago ou cancelado não conta no saldo a pagar.
 *
 * Mutação: remover o filtro status='inscrito' do saldo a pagar (somar tudo) derruba o
 * teste; trocar processado por não-processado no saldoPorTipo também.
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

const dir = mkdtempSync(join(tmpdir(), "restos-summary-test-"));

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
    await bundle("src/lib/restos-a-pagar.functions.ts", "rs.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("consolida por situação e o saldo a pagar por tipo", async () => {
  // Inscreve 2 processados (100, 50) e 1 não-processado (30) do exercício 2025.
  await seedCommitment("liquidado", 100);
  await seedCommitment("liquidado", 50);
  await seedCommitment("empenhado", 30);
  await fn.inscribeRestosAPagar({
    data: { tenant_id: tenantId, exercicio: 2025, inscrito_em: "2025-12-31" },
    context: ctx(),
  });

  // Paga um processado (50) e cancela o não-processado (30) — saem do saldo a pagar.
  const restos = (
    await db.query(
      "select r.id, r.valor::text v, c.status from public.restos_a_pagar r join public.budget_commitments c on c.id=r.commitment_id where r.tenant_id=$1 order by r.valor",
      [tenantId],
    )
  ).rows;
  const proc50 = restos.find((r) => r.v === "50.00");
  const nproc30 = restos.find((r) => r.v === "30.00");
  await fn.payRestoAPagar({
    data: {
      tenant_id: tenantId,
      resto_id: proc50.id,
      data_pagamento: "2026-02-01",
    },
    context: ctx(),
  });
  await fn.cancelRestoAPagar({
    data: {
      tenant_id: tenantId,
      resto_id: nproc30.id,
      motivo: "Prescricao",
      data_cancelamento: "2026-02-01",
    },
    context: ctx(),
  });

  const r = await fn.getRestosAPagarSummary({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  // Sobrou 1 inscrito processado de 100.
  assert.equal(r.porStatus.inscrito.qtd, 1);
  assert.equal(r.porStatus.inscrito.valor, 100);
  assert.equal(r.porStatus.pago.valor, 50);
  assert.equal(r.porStatus.cancelado.valor, 30);
  // Saldo a pagar = só o inscrito (100), todo processado.
  assert.equal(r.saldoAPagar, 100);
  assert.equal(r.saldoPorTipo.processado, 100);
  assert.equal(r.saldoPorTipo.nao_processado, 0);
});
