/**
 * O1-04b — ponto apurado valorado na folha: teste de COMPORTAMENTO (ponta a ponta).
 *
 * Fecha o laco ponto->folha: marcacoes -> apuracao (extras) -> depositTimeApuracao
 * valora (extras x salario-hora x adicional) e grava em payroll_monthly_variables
 * -> o ciclo (O1-04a) aplica. Tambem: re-depositar substitui (idempotente, sem
 * duplicar) e a valoracao usa parametros explicitos do RH.
 *
 * Mutacao: nao multiplicar pelo adicional, ou nao apagar antes de reinserir, derruba.
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
let rubricId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "ponto-folha-test-"));

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
  `const PERMS = ["people.read","people.manage","payroll.assignments.manage","payroll.simulate"];
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
  // base_salary 4400, 40h/semana -> salario-hora 4400/220 = 20.
  await db.query(
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status, base_salary, weekly_hours) values ($1,$2,$3,'MAT-P','rascunho',4400,40)",
    [linkId, tenantId, personId],
  );
  // Rubrica de horas extras (recebe o valor informado).
  rubricId = randomUUID();
  await db.query(
    `insert into public.payroll_rubrics
       (id, tenant_id, code, name, nature, unit, calculation_order, status, created_by)
     values ($1,$2,'HE','Horas extras','provento','valor',20,'ativo',$3)`,
    [rubricId, tenantId, userId],
  );
  const { ast, checksum } = (
    await bundle("src/lib/payroll-formula.server.ts", "f.mjs")
  ).checksumFormulaAst({ type: "variable", name: "fixed_amount" });
  await db.query(
    `insert into public.payroll_rubric_versions
       (id, tenant_id, rubric_id, version_number, valid_from, status,
        rounding_scale, rounding_mode, formula_ast, formula_checksum, published_by, created_by)
     values ($1,$2,$3,1,'2025-01-01','publicada',2,'half_up',$4::jsonb,$5,$6,$6)`,
    [randomUUID(), tenantId, rubricId, JSON.stringify(ast), checksum, userId],
  );

  Object.assign(fn, await bundle("src/lib/time-clock.functions.ts", "tc.mjs"));
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

async function punch(when) {
  return fn.recordTimeClockPunch({
    data: { tenant_id: tenantId, employment_link_id: linkId, punch_time: when },
    context: ctx(),
  });
}

async function deposit() {
  return fn.depositTimeApuracao({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      reference_month: "2025-06",
      overtime_rubric_id: rubricId,
      overtime_multiplier: 1.5,
      time_zone: "UTC",
    },
    context: ctx(),
  });
}

test("valora o ponto apurado e deposita na folha; o ciclo aplica", async () => {
  // Terca 2025-06-10, 10h de trabalho (11-21 UTC) => 600 min; previsto 480 =>
  // 120 min extra. Valor = (120/60)*20*1.5 = 60.
  await punch("2025-06-10T11:00:00.000Z");
  await punch("2025-06-10T21:00:00.000Z");
  const dep = await deposit();
  assert.equal(dep.extraMinutes, 120);
  assert.equal(dep.overtimeAmount, 60);

  const mv = (
    await db.query(
      "select amount from public.payroll_monthly_variables where tenant_id=$1 and employment_link_id=$2 and rubric_id=$3 and reference_month='2025-06-01'",
      [tenantId, linkId, rubricId],
    )
  ).rows;
  assert.equal(mv.length, 1);
  assert.equal(Number(mv[0].amount), 60);

  // O ciclo (O1-04a) aplica a variavel mensal depositada.
  const run = await fn.runPayrollSimulation({
    data: {
      tenant_id: tenantId,
      reference_month: "2025-06",
      employment_link_ids: [linkId],
    },
    context: ctx(),
  });
  const item = (
    await db.query(
      "select amount from public.payroll_calculation_items where run_id=$1 and rubric_id=$2",
      [run.runId, rubricId],
    )
  ).rows[0];
  assert.ok(item, "item de HE ausente na folha");
  assert.equal(Number(item.amount), 60);
});

test("re-depositar substitui o valor da competencia (idempotente)", async () => {
  const before = (
    await db.query(
      "select count(*)::int as n from public.payroll_monthly_variables where employment_link_id=$1 and rubric_id=$2 and reference_month='2025-06-01'",
      [linkId, rubricId],
    )
  ).rows[0].n;
  assert.equal(before, 1);
  await deposit();
  const after = (
    await db.query(
      "select count(*)::int as n, max(amount) as amount from public.payroll_monthly_variables where employment_link_id=$1 and rubric_id=$2 and reference_month='2025-06-01'",
      [linkId, rubricId],
    )
  ).rows[0];
  assert.equal(after.n, 1, "re-deposito nao pode duplicar");
  assert.equal(Number(after.amount), 60);
});
