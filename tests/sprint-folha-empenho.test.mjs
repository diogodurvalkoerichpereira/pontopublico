/**
 * O2-04 (Onda 2) — folha → orçamento: COMPORTAMENTO (ponta a ponta).
 *
 * Fecha o laço: a requisição de empenho da folha (O1-08) vira empenhos reais
 * contra dotação (O2-02), um por linha (natureza), reservando saldo. Confere:
 *  - cada linha empenhada reduz o saldo da dotação alocada;
 *  - a requisição passa a 'empenhada' e não pode ser empenhada duas vezes;
 *  - toda linha precisa ser alocada.
 *
 * Mutação: não marcar a requisição como empenhada (re-empenho duplica) derruba.
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

const dir = mkdtempSync(join(tmpdir(), "folha-empenho-test-"));

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
  `const PERMS = ["budget.read","budget.manage","payroll.cycles.read","payroll.cycles.close"];
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

async function seedDotacao(natureza, orcado, acao = "2001") {
  return (
    await fn.saveBudgetAppropriation({
      data: {
        tenant_id: tenantId,
        exercicio: 2025,
        unidade_orcamentaria: "02.01",
        funcao: "04",
        subfuncao: "122",
        programa: "0001",
        acao,
        natureza_despesa: natureza,
        fonte_recurso: "1.500.0000",
        valor_orcado: orcado,
        status: "ativa",
      },
      context: ctx(),
    })
  ).id;
}

let closedCycleId;

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
  Object.assign(
    fn,
    await bundle("src/lib/payroll-empenho.functions.ts", "emp.mjs"),
  );
  // Folha mensal fechada com proventos 5000.
  closedCycleId = randomUUID();
  await db.query(
    `insert into public.payroll_cycles
       (id,tenant_id,reference_month,cycle_type,sequence,status,version,
        links_count,items_count,total_earnings,total_deductions,total_net,prepared_by)
     values ($1,$2,'2025-06-01','mensal',1,'fechada',1,1,3,5000,1000,4000,$3)`,
    [closedCycleId, tenantId, userId],
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("a requisição de empenho da folha vira empenhos contra dotação, reservando saldo", async () => {
  const dotA = await seedDotacao("3.1.90.11.00", 10000);
  const dotB = await seedDotacao("3.1.90.16.00", 10000);
  // Emite a requisição (O1-08): duas linhas somando a despesa bruta (5000).
  const req = await fn.emitPayrollEmpenhoRequest({
    data: {
      tenant_id: tenantId,
      cycle_id: closedCycleId,
      fonte_recurso: "1.500.0000",
      lines: [
        {
          natureza_despesa: "3.1.90.11.00",
          description: "Vencimentos",
          amount: 4000,
        },
        {
          natureza_despesa: "3.1.90.16.00",
          description: "Outras variaveis",
          amount: 1000,
        },
      ],
    },
    context: ctx(),
  });
  const lines = (
    await db.query(
      "select id, natureza_despesa from public.payroll_empenho_request_lines where request_id=$1",
      [req.id],
    )
  ).rows;
  const alloc = lines.map((l) => ({
    line_id: l.id,
    appropriation_id: l.natureza_despesa === "3.1.90.11.00" ? dotA : dotB,
  }));

  const result = await fn.commitPayrollEmpenho({
    data: {
      tenant_id: tenantId,
      request_id: req.id,
      data_empenho: "2025-06-30",
      allocations: alloc,
    },
    context: ctx(),
  });
  assert.equal(result.commitments.length, 2);

  const ws = await fn.getBudgetAppropriations({
    data: { tenant_id: tenantId, exercicio: 2025 },
    context: ctx(),
  });
  const byId = new Map(ws.appropriations.map((a) => [a.id, a]));
  assert.equal(Number(byId.get(dotA).valor_empenhado), 4000);
  assert.equal(Number(byId.get(dotB).valor_empenhado), 1000);

  // A requisição virou 'empenhada' e não pode empenhar de novo.
  await assert.rejects(
    fn.commitPayrollEmpenho({
      data: {
        tenant_id: tenantId,
        request_id: req.id,
        data_empenho: "2025-06-30",
        allocations: alloc,
      },
      context: ctx(),
    }),
    /já foi empenhada/,
  );
});

test("empenhar sem alocar todas as linhas é recusado", async () => {
  const cycle2 = randomUUID();
  await db.query(
    `insert into public.payroll_cycles
       (id,tenant_id,reference_month,cycle_type,sequence,status,version,
        links_count,items_count,total_earnings,total_deductions,total_net,prepared_by)
     values ($1,$2,'2025-07-01','mensal',1,'fechada',1,1,3,3000,0,3000,$3)`,
    [cycle2, tenantId, userId],
  );
  const dot = await seedDotacao("3.1.90.11.00", 10000, "2099");
  const req = await fn.emitPayrollEmpenhoRequest({
    data: {
      tenant_id: tenantId,
      cycle_id: cycle2,
      fonte_recurso: "1.500.0000",
      lines: [
        {
          natureza_despesa: "3.1.90.11.00",
          description: "Vencimentos",
          amount: 3000,
        },
      ],
    },
    context: ctx(),
  });
  await assert.rejects(
    fn.commitPayrollEmpenho({
      data: {
        tenant_id: tenantId,
        request_id: req.id,
        data_empenho: "2025-07-31",
        // Aloca um line_id que não é o da requisição: não cobre a linha real.
        allocations: [{ line_id: randomUUID(), appropriation_id: dot }],
      },
      context: ctx(),
    }),
    /alocada/,
  );
});
