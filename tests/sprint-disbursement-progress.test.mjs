/**
 * O2-19b (Onda 2) — Execução acumulada do cronograma de desembolso (LRF): COMPORTAMENTO.
 *
 * getDisbursementProgress confronta, do início do exercício ATÉ o mês de referência
 * (inclusive), o programado (cotas) com o realizado (despesa paga no período) e diz se a
 * execução está dentro do programado. Cota ou pagamento após o mês de referência não entra.
 *
 * Mutação: trocar o limite do mês (mes <= ref) por "sem limite" soma meses futuros e
 * derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "disbursement-progress-test-"));

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

async function seedQuota(mes, fonte, valor) {
  await db.query(
    `insert into public.disbursement_schedules
       (id, tenant_id, exercicio, mes, fonte_recurso, valor_programado)
     values ($1,$2,2026,$3,$4,$5)`,
    [randomUUID(), tenantId, mes, fonte, valor],
  );
}

async function seedPaidCommitment(pagoEm, valor) {
  numeroSeq += 1;
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho, credor,
        historico, valor, status, pago_em)
     values ($1,$2,$3,2026,$4,'2026-01-05','Credor','Empenho',$5,'pago',$6)`,
    [randomUUID(), tenantId, appropriationId, numeroSeq, valor, pagoEm],
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
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado)
     values ($1,$2,2026,'01','04','122','0001','2001','3.3.90.30','1500',1000000)`,
    [appropriationId, tenantId],
  );
  Object.assign(
    fn,
    await bundle("src/lib/disbursement-schedule.functions.ts", "ds.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("acumula até o mês de referência; ignora cotas e pagamentos posteriores", async () => {
  // Cotas: jan 1000, fev 1000, mar 1000.
  await seedQuota(1, "1500", 1000);
  await seedQuota(2, "1500", 1000);
  await seedQuota(3, "1500", 1000);
  // Pagos: jan 800, fev 900, mar 5000 (março não deve entrar até fev).
  await seedPaidCommitment("2026-01-20", 800);
  await seedPaidCommitment("2026-02-15", 900);
  await seedPaidCommitment("2026-03-10", 5000);

  const r = await fn.getDisbursementProgress({
    data: { tenant_id: tenantId, exercicio: 2026, ate_mes: 2 },
    context: ctx(),
  });

  assert.equal(r.programado, 2000); // jan + fev
  assert.equal(r.realizado, 1700); // 800 + 900, sem os 5000 de março
  assert.equal(r.saldo, 300);
  assert.equal(r.percentualExecucao, 85); // 1700 / 2000
  assert.equal(r.dentroDoCronograma, true);
});
