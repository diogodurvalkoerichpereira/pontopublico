/**
 * O1-08 — requisicao de empenho da folha (PCASP): teste de COMPORTAMENTO.
 *
 * Uma folha mensal FECHADA emite a requisicao de empenho: a despesa bruta de
 * pessoal (proventos do ciclo) classificada por natureza de despesa. Confere:
 *  - as linhas TEM de somar a despesa bruta (proventos) — sem sobra nem falta;
 *  - so folha fechada empenha;
 *  - uma requisicao por folha (nao duplica).
 *
 * Mutacao: nao exigir que as linhas somem a despesa bruta derruba o teste do
 * desbalanceamento.
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
let closedCycle;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "empenho-test-"));

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
  `const PERMS = ["payroll.cycles.read","payroll.cycles.close"];
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

let monthSeq = 0;
async function seedCycle(status, earnings) {
  const id = randomUUID();
  // Cada folha numa competencia distinta (unique tenant/mes/tipo/sequencia).
  monthSeq += 1;
  const month = `2025-${String(monthSeq).padStart(2, "0")}-01`;
  await db.query(
    `insert into public.payroll_cycles
       (id,tenant_id,reference_month,cycle_type,sequence,status,version,
        links_count,items_count,total_earnings,total_deductions,total_net,prepared_by)
     values ($1,$2,$3,'mensal',1,$4,1,1,3,$5,$6,$7,$8)`,
    [
      id,
      tenantId,
      month,
      status,
      earnings,
      Number((earnings * 0.2).toFixed(2)),
      Number((earnings * 0.8).toFixed(2)),
      userId,
    ],
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
  closedCycle = await seedCycle("fechada", 5000);
  Object.assign(
    fn,
    await bundle("src/lib/payroll-empenho.functions.ts", "emp.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ userId });

function emit(cycleId, lines) {
  return fn.emitPayrollEmpenhoRequest({
    data: {
      tenant_id: tenantId,
      cycle_id: cycleId,
      fonte_recurso: "1.500.0000",
      lines,
    },
    context: ctx(),
  });
}

test("a requisicao de empenho da folha fechada e emitida e persistida", async () => {
  const r = await emit(closedCycle, [
    {
      natureza_despesa: "3.1.90.11.00",
      description: "Vencimentos e vantagens fixas",
      amount: 4200,
    },
    {
      natureza_despesa: "3.1.90.16.00",
      description: "Outras despesas variaveis de pessoal",
      amount: 800,
    },
  ]);
  assert.equal(r.total, 5000);
  assert.equal(r.lines, 2);

  const ws = await fn.getPayrollEmpenhoRequests({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  assert.equal(ws.requests.length, 1);
  assert.equal(Number(ws.requests[0].total_amount), 5000);
  assert.equal(ws.requests[0].status, "emitida");
  assert.equal(ws.lines.length, 2);
});

test("as linhas precisam somar a despesa bruta de pessoal (proventos)", async () => {
  const cycle = await seedCycle("fechada", 3000);
  await assert.rejects(
    emit(cycle, [
      {
        natureza_despesa: "3.1.90.11.00",
        description: "Vencimentos",
        amount: 2500,
      },
    ]),
    /somar a despesa bruta/,
  );
});

test("so folha fechada empenha", async () => {
  const previa = await seedCycle("previa", 3000);
  await assert.rejects(
    emit(previa, [
      {
        natureza_despesa: "3.1.90.11.00",
        description: "Vencimentos",
        amount: 3000,
      },
    ]),
    /fechada/,
  );
});

test("uma requisicao por folha (nao duplica)", async () => {
  await assert.rejects(
    emit(closedCycle, [
      {
        natureza_despesa: "3.1.90.11.00",
        description: "Vencimentos",
        amount: 5000,
      },
    ]),
    /já tem requisição/,
  );
});
