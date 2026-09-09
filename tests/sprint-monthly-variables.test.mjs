/**
 * O1-04 — o ciclo lê as variáveis mensais: teste de COMPORTAMENTO (ponta a ponta).
 *
 * Liga as ilhas: um valor por vínculo/rubrica/competência em
 * `payroll_monthly_variables` (folha de ponto valorada, importação, item pontual)
 * passa a ser aplicado por `runPayrollSimulation` como `fixed_amount`. Também: a
 * atribuição explícita por vínculo tem precedência sobre a variável mensal (sem
 * dupla contagem).
 *
 * Mutação: remover o merge das variáveis mensais, ou o dedup de precedência, derruba.
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
let linkId;
let userId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "monthly-var-test-"));

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
  `const PERMS = ["people.read","people.manage","payroll.catalog.read","payroll.catalog.manage",
     "payroll.assignments.manage","payroll.simulate"];
   export async function loadTenantAccess() { return { permissions: PERMS }; }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }
   export async function loadTenantUnitScope() { return { global: true, unitIds: [] }; }
   export function requireUnitInScope() {}`,
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

// Rubrica de provento cuja formula apenas ecoa o fixed_amount (valor informado).
async function seedEchoRubric(code) {
  const rubricId = randomUUID();
  await db.query(
    `insert into public.payroll_rubrics
       (id, tenant_id, code, name, nature, unit, calculation_order, status, created_by)
     values ($1,$2,$3,'Valor informado','provento','valor',10,'ativo',$4)`,
    [rubricId, tenantId, code, userId],
  );
  const { ast, checksum } = fn.checksumFormulaAst({
    type: "variable",
    name: "fixed_amount",
  });
  await db.query(
    `insert into public.payroll_rubric_versions
       (id, tenant_id, rubric_id, version_number, valid_from, status,
        rounding_scale, rounding_mode, formula_ast, formula_checksum, published_by, created_by)
     values ($1,$2,$3,1,'2025-01-01','publicada',2,'half_up',$4::jsonb,$5,$6,$6)`,
    [randomUUID(), tenantId, rubricId, JSON.stringify(ast), checksum, userId],
  );
  return rubricId;
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
  const personId = randomUUID();
  linkId = randomUUID();
  await db.query(
    "insert into public.persons (id, full_name) values ($1,'Servidor')",
    [personId],
  );
  await db.query(
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status, base_salary) values ($1,$2,$3,'MAT-V','rascunho',5000)",
    [linkId, tenantId, personId],
  );
  Object.assign(fn, await bundle("src/lib/payroll-formula.server.ts", "f.mjs"));
  Object.assign(
    fn,
    await bundle("src/lib/payroll-simulation.functions.ts", "sim.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ userId });

async function runCycle() {
  return fn.runPayrollSimulation({
    data: {
      tenant_id: tenantId,
      reference_month: "2025-06",
      employment_link_ids: [linkId],
    },
    context: ctx(),
  });
}

test("a variável mensal é aplicada pelo ciclo como fixed_amount", async () => {
  const rubricId = await seedEchoRubric("VAR_MES");
  await db.query(
    `insert into public.payroll_monthly_variables
       (tenant_id, employment_link_id, rubric_id, reference_month, amount, installment_number, installments_total)
     values ($1,$2,$3,'2025-06-01',250,1,1)`,
    [tenantId, linkId, rubricId],
  );
  const run = await runCycle();
  assert.equal(run.itemsCalculated, 1);
  const item = (
    await db.query(
      "select amount from public.payroll_calculation_items where run_id=$1 and rubric_id=$2",
      [run.runId, rubricId],
    )
  ).rows[0];
  assert.ok(item, "item da variavel mensal ausente");
  assert.equal(Number(item.amount), 250);
});

test("a atribuição explícita tem precedência sobre a variável mensal (sem dobra)", async () => {
  const rubricId = await seedEchoRubric("VAR_MES2");
  // Variavel mensal (250) E atribuicao explicita (fixed_amount 999) da mesma rubrica.
  await db.query(
    `insert into public.payroll_monthly_variables
       (tenant_id, employment_link_id, rubric_id, reference_month, amount, installment_number, installments_total)
     values ($1,$2,$3,'2025-06-01',250,1,1)`,
    [tenantId, linkId, rubricId],
  );
  await db.query(
    `insert into public.employment_link_rubrics
       (id, tenant_id, employment_link_id, rubric_id, valid_from, fixed_amount, status, created_by)
     values ($1,$2,$3,$4,'2025-01-01',999,'ativo',$5)`,
    [randomUUID(), tenantId, linkId, rubricId, userId],
  );
  const run = await runCycle();
  const items = (
    await db.query(
      "select amount from public.payroll_calculation_items where run_id=$1 and rubric_id=$2",
      [run.runId, rubricId],
    )
  ).rows;
  assert.equal(items.length, 1, "a rubrica nao pode ser aplicada em dobro");
  assert.equal(
    Number(items[0].amount),
    999,
    "a atribuicao explicita deve vencer",
  );
});
