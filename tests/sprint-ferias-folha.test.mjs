/**
 * O1-05b — ferias tributadas pela via do ciclo: teste de COMPORTAMENTO (ponta a ponta).
 *
 * A retencao correta de ferias NAO e um INSS isolado no agendamento: a remuneracao
 * de ferias integra o salario-de-contribuicao da competencia (teto unico do INSS).
 * Aqui: deposita-se a remuneracao de ferias em payroll_monthly_variables
 * (depositVacationToPayroll) e o CICLO tributa a base COMBINADA (salario + ferias)
 * por incidencias.
 *
 * Prova a recomposicao: salario 3000 + ferias 3000 => inss_base 6000 => INSS 649.60
 * (progressivo sobre 6000). Se as ferias fossem tributadas a parte seria
 * 253.41+253.41 = 506.82; so o salario seria 253.41. O ciclo retem 649.60.
 *
 * Mutacao: nao ordenar as fontes por calculation_order (o INSS, atribuicao de ordem
 * alta, correria antes da variavel mensal das ferias e nao veria a base) derruba.
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
let salRubric;
let inssRubric;
let ferRubric;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "ferias-folha-test-"));

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
  `const PERMS = ["vacation.read","vacation.manage","payroll.assignments.manage","payroll.simulate"];
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

// Rubrica com formula arbitraria, inserida ja 'ativo'/'publicada'; devolve id.
async function seedRubric(code, nature, order, ast) {
  const rubricId = randomUUID();
  await db.query(
    `insert into public.payroll_rubrics
       (id, tenant_id, code, name, nature, unit, calculation_order, status, created_by)
     values ($1,$2,$3,$3,$4,'valor',$5,'ativo',$6)`,
    [rubricId, tenantId, code, nature, order, userId],
  );
  const { checksum } = fn.checksumFormulaAst(ast);
  const versionId = randomUUID();
  await db.query(
    `insert into public.payroll_rubric_versions
       (id, tenant_id, rubric_id, version_number, valid_from, status,
        rounding_scale, rounding_mode, formula_ast, formula_checksum, published_by, created_by)
     values ($1,$2,$3,1,'2025-01-01','publicada',2,'half_up',$4::jsonb,$5,$6,$6)`,
    [versionId, tenantId, rubricId, JSON.stringify(ast), checksum, userId],
  );
  return { rubricId, versionId };
}

async function feedInss(versionId) {
  await db.query(
    `insert into public.payroll_rubric_incidences
       (tenant_id, version_id, base_code, factor, active, created_by)
     values ($1,$2,'inss',100,true,$3)`,
    [tenantId, versionId, userId],
  );
}

async function assign(rubricId) {
  // quantity=1 so satisfaz o payload_check; a formula usa salary_base/inss_base.
  await db.query(
    `insert into public.employment_link_rubrics
       (id, tenant_id, employment_link_id, rubric_id, valid_from, quantity, status, created_by)
     values ($1,$2,$3,$4,'2025-01-01',1,'ativo',$5)`,
    [randomUUID(), tenantId, linkId, rubricId, userId],
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
  const personId = randomUUID();
  linkId = randomUUID();
  await db.query(
    "insert into public.persons (id, full_name) values ($1,'Servidor')",
    [personId],
  );
  await db.query(
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status, base_salary) values ($1,$2,$3,'MAT-F','rascunho',3000)",
    [linkId, tenantId, personId],
  );

  Object.assign(fn, await bundle("src/lib/payroll-formula.server.ts", "f.mjs"));
  Object.assign(fn, await bundle("src/lib/vacation.functions.ts", "vac.mjs"));
  Object.assign(
    fn,
    await bundle("src/lib/payroll-simulation.functions.ts", "sim.mjs"),
  );

  // Salario (alimenta inss_base), INSS (le inss_base), ferias (alimenta inss_base).
  const sal = await seedRubric("SAL", "provento", 10, {
    type: "variable",
    name: "salary_base",
  });
  salRubric = sal.rubricId;
  await feedInss(sal.versionId);
  const inss = await seedRubric("INSS", "desconto", 90, {
    type: "table_lookup",
    table: "INSS_FEDERAL",
    mode: "progressive",
    base: { type: "variable", name: "inss_base" },
  });
  inssRubric = inss.rubricId;
  const fer = await seedRubric("FER", "provento", 20, {
    type: "variable",
    name: "fixed_amount",
  });
  ferRubric = fer.rubricId;
  await feedInss(fer.versionId);
  await assign(salRubric);
  await assign(inssRubric);

  // Periodo aquisitivo + agendamento de ferias (base 2000 + 1/3 1000 = 3000).
  const policyId = randomUUID();
  await db.query(
    `insert into public.vacation_policies(id,tenant_id,name,effective_from) values ($1,$2,'R',' 2025-01-01')`,
    [policyId, tenantId],
  );
  const periodId = randomUUID();
  await db.query(
    `insert into public.vacation_accrual_periods(id,tenant_id,employment_link_id,policy_id,accrual_start,accrual_end,concession_deadline,entitled_days,status)
     values ($1,$2,$3,$4,'2024-01-01','2024-12-31','2025-12-31',30,'disponivel')`,
    [periodId, tenantId, linkId, policyId],
  );
  const scheduleId = randomUUID();
  await db.query(
    `insert into public.vacation_schedules(id,tenant_id,accrual_period_id,start_date,end_date,days,base_amount,bonus_amount,total_amount,payment_date,memory,created_by)
     values ($1,$2,$3,'2025-06-10','2025-06-29',20,2000,1000,3000,'2025-06-08','{}'::jsonb,$4)`,
    [scheduleId, tenantId, periodId, userId],
  );
  globalThis.__scheduleId = scheduleId;
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  delete globalThis.__scheduleId;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ userId });

test("as ferias depositadas sao tributadas junto com o salario (recomposicao)", async () => {
  const dep = await fn.depositVacationToPayroll({
    data: {
      tenant_id: tenantId,
      schedule_id: globalThis.__scheduleId,
      vacation_rubric_id: ferRubric,
    },
    context: ctx(),
  });
  assert.equal(dep.reference_month, "2025-06-01");
  assert.equal(dep.base, 2000);
  assert.equal(dep.bonus, 1000);

  const run = await fn.runPayrollSimulation({
    data: {
      tenant_id: tenantId,
      reference_month: "2025-06",
      employment_link_ids: [linkId],
    },
    context: ctx(),
  });

  const items = (
    await db.query(
      "select rubric_id, amount from public.payroll_calculation_items where run_id=$1",
      [run.runId],
    )
  ).rows;
  const by = new Map(items.map((i) => [i.rubric_id, Number(i.amount)]));
  assert.equal(by.get(salRubric), 3000, "salario");
  assert.equal(by.get(ferRubric), 3000, "ferias (base + 1/3)");
  // INSS progressivo sobre 6000 (salario + ferias), nao 253.41 (so salario) nem
  // 506.82 (ferias tributadas a parte).
  assert.equal(by.get(inssRubric), 649.6, "INSS sobre a base combinada");
});

test("re-depositar substitui a competencia (idempotente)", async () => {
  await fn.depositVacationToPayroll({
    data: {
      tenant_id: tenantId,
      schedule_id: globalThis.__scheduleId,
      vacation_rubric_id: ferRubric,
    },
    context: ctx(),
  });
  const n = (
    await db.query(
      "select count(*)::int as n from public.payroll_monthly_variables where employment_link_id=$1 and rubric_id=$2 and reference_month='2025-06-01'",
      [linkId, ferRubric],
    )
  ).rows[0].n;
  assert.equal(n, 1, "re-deposito nao pode duplicar");
});
