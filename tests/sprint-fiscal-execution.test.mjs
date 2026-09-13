/**
 * O4-09 (Onda 4) — execução fiscal (Lei 6.830): COMPORTAMENTO.
 *
 * fileFiscalExecution ajuíza a cobrança de uma CDA ativa, fixando o valor ajuizado do
 * valor inscrito; uma execução por CDA. updateFiscalExecutionStatus move o andamento e
 * trava as execuções encerradas (extinta/quitada). Confere o valor, a guarda de CDA
 * ativa, a unicidade e a transição terminal.
 *
 * Mutação: aceitar CDA não ativa (inverter a guarda) derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "fiscal-exec-test-"));

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
  `const PERMS = ["taxes.read","taxes.manage"];
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
async function seedCda(valorInscrito, status) {
  seq += 1;
  const creditId = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',2026,'Contribuinte','00000000000',$3,$4,0,'2026-01-01','divida_ativa')`,
    [creditId, tenantId, `INSC-${seq}`, valorInscrito],
  );
  const cdaId = randomUUID();
  await db.query(
    `insert into public.active_debt_certificates
       (id, tenant_id, exercicio, numero, credit_id, valor_inscrito,
        data_inscricao, status)
     values ($1,$2,2026,$3,$4,$5,'2026-04-01',$6)`,
    [cdaId, tenantId, seq, creditId, valorInscrito, status],
  );
  return cdaId;
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
    await bundle("src/lib/fiscal-execution.functions.ts", "fe.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

let procSeq = 0;
const file = (cda) => {
  procSeq += 1;
  return fn.fileFiscalExecution({
    data: {
      tenant_id: tenantId,
      cda_id: cda,
      numero_processo: `PROC-${procSeq}`,
      data_ajuizamento: "2026-05-01",
    },
    context: ctx(),
  });
};

test("ajuíza a CDA ativa fixando o valor; uma execução por CDA", async () => {
  const cda = await seedCda(800, "ativa");
  const r = await file(cda);
  assert.equal(r.valor_ajuizado, 800);

  await assert.rejects(file(cda), /já possui execução/i);
});

test("só uma CDA ativa ajuíza; execução encerrada é terminal", async () => {
  const cancelada = await seedCda(500, "cancelada");
  await assert.rejects(file(cancelada), /ativa/i);

  const cda = await seedCda(1000, "ativa");
  const r = await file(cda);
  await fn.updateFiscalExecutionStatus({
    data: { tenant_id: tenantId, execution_id: r.id, status: "extinta" },
    context: ctx(),
  });
  await assert.rejects(
    fn.updateFiscalExecutionStatus({
      data: { tenant_id: tenantId, execution_id: r.id, status: "suspensa" },
      context: ctx(),
    }),
    /encerrada/i,
  );
});

const cdaStatus = async (cdaId) =>
  (
    await db.query(
      "select status from public.active_debt_certificates where id=$1",
      [cdaId],
    )
  ).rows[0].status;

test("execução quitada baixa a CDA; suspensa não mexe na CDA", async () => {
  // Suspender a execução não altera a CDA (segue ativa, no estoque em cobrança).
  const cdaSusp = await seedCda(700, "ativa");
  const rSusp = await file(cdaSusp);
  await fn.updateFiscalExecutionStatus({
    data: { tenant_id: tenantId, execution_id: rSusp.id, status: "suspensa" },
    context: ctx(),
  });
  assert.equal(await cdaStatus(cdaSusp), "ativa");

  // Quitar a execução baixa a CDA para 'quitada'.
  const cdaQuit = await seedCda(900, "ativa");
  const rQuit = await file(cdaQuit);
  await fn.updateFiscalExecutionStatus({
    data: { tenant_id: tenantId, execution_id: rQuit.id, status: "quitada" },
    context: ctx(),
  });
  assert.equal(await cdaStatus(cdaQuit), "quitada");
});
