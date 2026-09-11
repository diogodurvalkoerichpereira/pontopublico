/**
 * O2-19 (Onda 2) — cronograma de desembolso (Lei 4.320 art. 47-50): COMPORTAMENTO.
 *
 * saveDisbursementQuota programa cotas mensais por fonte (upsert por
 * ente/exercício/mês/fonte); getDisbursementSchedule confronta, mês a mês, o
 * programado com o realizado (despesa paga no mês) e apura o saldo da cota
 * (programado − realizado, negativo = estouro). Confere a soma por mês, o realizado
 * pelo mês do pagamento, o saldo e a substituição por upsert.
 *
 * Mutação: somar em vez de subtrair no saldo derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "disbursement-test-"));

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

let numeroSeq = 0;
async function seedPaid(valor, pagoEm) {
  numeroSeq += 1;
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho,
        tipo, credor, historico, valor, status, pago_em)
     values ($1,$2,$3,2026,$4,'2026-01-05','ordinario','Fornecedor','Empenho',$5,'pago',$6)`,
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
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado, valor_empenhado)
     values ($1,$2,2026,'01','04','122','0001','2001','3.3.90.30','01',50000,0)`,
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

const save = (mes, fonte, valor) =>
  fn.saveDisbursementQuota({
    data: {
      tenant_id: tenantId,
      exercicio: 2026,
      mes,
      fonte_recurso: fonte,
      valor_programado: valor,
    },
    context: ctx(),
  });

test("confronta programado x realizado por mês e apura o saldo da cota", async () => {
  await save(1, "01", 1000);
  await save(1, "02", 500); // mês 1 soma as fontes: 1500
  await save(2, "01", 800);

  await seedPaid(1200, "2026-01-15T10:00:00Z"); // realizado mês 1
  await seedPaid(900, "2026-02-10T10:00:00Z"); // realizado mês 2
  // Um empenho liquidado (não pago) não entra no realizado.
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho,
        tipo, credor, historico, valor, status)
     values ($1,$2,$3,2026,999,'2026-01-05','ordinario','X','E',7000,'liquidado')`,
    [randomUUID(), tenantId, appropriationId],
  );

  const r = await fn.getDisbursementSchedule({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });

  assert.equal(r.meses.length, 12);
  const m1 = r.meses[0];
  assert.equal(m1.programado, 1500);
  assert.equal(m1.realizado, 1200);
  assert.equal(m1.saldo, 300);
  const m2 = r.meses[1];
  assert.equal(m2.programado, 800);
  assert.equal(m2.realizado, 900);
  assert.equal(m2.saldo, -100); // estouro da cota

  assert.equal(r.totais.programado, 2300);
  assert.equal(r.totais.realizado, 2100);
  assert.equal(r.totais.saldo, 200);
});

test("upsert substitui a cota da mesma fonte/mês", async () => {
  await save(1, "01", 2000); // era 1000 → vira 2000
  const r = await fn.getDisbursementSchedule({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  // mês 1: 2000 (fonte 01) + 500 (fonte 02) = 2500
  assert.equal(r.meses[0].programado, 2500);
});
