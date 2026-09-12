/**
 * O1-02c — atribuição de rubricas por regime: teste de COMPORTAMENTO (ponta a ponta).
 *
 * Sobe o esquema real em PGlite e EXECUTA a folha inteira com handlers reais: cria
 * a tabela RPPS do ente, uma rubrica de desconto cuja fórmula é `table_lookup`
 * contra ela, mapeia a rubrica ao regime, cria um servidor NAQUELE regime SEM
 * atribuição manual, e roda `runPayrollSimulation` — o item de RPPS aparece com o
 * valor progressivo e o checksum da versão da tabela na memória. Também: a
 * atribuição explícita por vínculo tem precedência (sem dupla contagem) e a
 * coerência de entidade do mapeamento.
 *
 * Mutação: remover o merge dos regimeSources no ciclo, ou o filtro de dedup,
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
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "pension-rubrics-test-"));

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
  `const PERMS = ["people.read","people.manage","people.sensitive.read","fiscal.read",
     "fiscal.manage","payroll.catalog.read","payroll.catalog.manage",
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

before(async () => {
  db = await createTestDb();
  globalThis.__db = db;
  tenantId = (
    await db.query(
      "select id from public.tenants order by created_at, id limit 1",
    )
  ).rows[0].id;
  // Ator real (profiles.id -> app_users.id): os handlers gravam created_by/
  // published_by com esse id.
  userId = randomUUID();
  await db.query(
    "insert into public.app_users (id, email, password_hash) values ($1, $2, 'x')",
    [userId, `ator-${userId}@teste.local`],
  );
  await db.query("insert into public.profiles (id) values ($1)", [userId]);
  Object.assign(
    fn,
    await bundle("src/lib/pension-regimes.functions.ts", "pr.mjs"),
  );
  Object.assign(
    fn,
    await bundle("src/lib/fiscal-tables.functions.ts", "ft.mjs"),
  );
  Object.assign(
    fn,
    await bundle("src/lib/payroll-catalog.functions.ts", "cat.mjs"),
  );
  Object.assign(
    fn,
    await bundle("src/lib/payroll-formula.server.ts", "fsrv.mjs"),
  );
  Object.assign(fn, await bundle("src/lib/people.functions.ts", "ppl.mjs"));
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

// Cria a tabela RPPS do ente + uma rubrica de desconto com table_lookup contra ela.
async function seedRppsRubric(code) {
  const tableCode = "TBL_" + code;
  const { id: tableId } = await fn.saveFiscalTable({
    data: {
      tenant_id: tenantId,
      code: tableCode,
      name: "RPPS",
      status: "ativo",
    },
    context: ctx(),
  });
  await fn.saveFiscalTableVersion({
    data: {
      tenant_id: tenantId,
      fiscal_table_id: tableId,
      valid_from: "2025-01-01",
      status: "publicada",
      brackets: [
        { ate: 5000, aliquota: 0.11 },
        { ate: 999999999, aliquota: 0.14 },
      ],
    },
    context: ctx(),
  });
  const rubricId = randomUUID();
  await db.query(
    `insert into public.payroll_rubrics
       (id, tenant_id, code, name, nature, unit, calculation_order, status, created_by)
     values ($1,$2,$3,'Contribuicao RPPS','desconto','valor',50,'ativo',$4)`,
    [rubricId, tenantId, code, userId],
  );
  // Versao publicada com formula table_lookup, inserida direto (o checksum e o
  // mesmo que o ciclo reconfere via checksumFormulaAst).
  const { ast, checksum } = fn.checksumFormulaAst({
    type: "table_lookup",
    table: tableCode,
    mode: "progressive",
    base: { type: "variable", name: "salary_base" },
  });
  await db.query(
    `insert into public.payroll_rubric_versions
       (id, tenant_id, rubric_id, version_number, valid_from, status,
        rounding_scale, rounding_mode, formula_ast, formula_checksum,
        published_by, created_by)
     values ($1,$2,$3,1,'2025-01-01','publicada',2,'half_up',$4::jsonb,$5,$6,$6)`,
    [randomUUID(), tenantId, rubricId, JSON.stringify(ast), checksum, userId],
  );
  return rubricId;
}

async function makeServant(registration, regimeId) {
  await fn.savePersonAndLink({
    data: {
      tenant_id: tenantId,
      person: { full_name: "Servidor " + registration },
      link: {
        registration_number: registration,
        unit_id: null,
        pension_regime_id: regimeId,
        base_salary: 6000,
        status: "rascunho",
      },
    },
    context: ctx(),
  });
  return (
    await db.query(
      "select id from public.employment_links where registration_number=$1 and tenant_id=$2",
      [registration, tenantId],
    )
  ).rows[0].id;
}

test("o RPPS do regime aplica-se ao servidor sem atribuicao manual", async () => {
  const { id: regimeId } = await fn.savePensionRegime({
    data: {
      tenant_id: tenantId,
      code: "RPPS",
      name: "RPPS",
      regime_type: "rpps",
      status: "ativo",
    },
    context: ctx(),
  });
  const rubricId = await seedRppsRubric("RPPS_DESC");
  await fn.setPensionRegimeRubrics({
    data: {
      tenant_id: tenantId,
      pension_regime_id: regimeId,
      rubric_ids: [rubricId],
    },
    context: ctx(),
  });
  const linkId = await makeServant("SV-100", regimeId);

  const run = await fn.runPayrollSimulation({
    data: {
      tenant_id: tenantId,
      reference_month: "2025-06",
      employment_link_ids: [linkId],
    },
    context: ctx(),
  });
  assert.equal(
    run.itemsCalculated,
    1,
    "a rubrica do regime devia ter sido aplicada",
  );

  const item = (
    await db.query(
      "select amount, memory from public.payroll_calculation_items where run_id=$1 and rubric_id=$2",
      [run.runId, rubricId],
    )
  ).rows[0];
  assert.ok(item, "item de RPPS ausente");
  // salary_base 6000: 5000*0.11 + 1000*0.14 = 690
  assert.equal(Number(item.amount), 690);
  const step = item.memory.operations.find((s) => s.kind === "table_lookup");
  assert.ok(step?.tableChecksum, "checksum da tabela ausente na memoria");
});

test("atribuicao explicita por vinculo tem precedencia (sem dupla contagem)", async () => {
  const { id: regimeId } = await fn.savePensionRegime({
    data: {
      tenant_id: tenantId,
      code: "RPPS2",
      name: "RPPS2",
      regime_type: "rpps",
      status: "ativo",
    },
    context: ctx(),
  });
  const rubricId = await seedRppsRubric("RPPS_DESC2");
  await fn.setPensionRegimeRubrics({
    data: {
      tenant_id: tenantId,
      pension_regime_id: regimeId,
      rubric_ids: [rubricId],
    },
    context: ctx(),
  });
  const linkId = await makeServant("SV-200", regimeId);
  // Mesma rubrica atribuida explicitamente ao vinculo.
  await fn.saveEmploymentLinkRubric({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      rubric_id: rubricId,
      valid_from: "2025-01-01",
      valid_to: null,
      fixed_amount: null,
      quantity: null,
      parameters: { marker: 1 },
      status: "ativo",
      notes: null,
    },
    context: ctx(),
  });

  const run = await fn.runPayrollSimulation({
    data: {
      tenant_id: tenantId,
      reference_month: "2025-06",
      employment_link_ids: [linkId],
    },
    context: ctx(),
  });
  assert.equal(
    run.itemsCalculated,
    1,
    "a rubrica nao pode ser aplicada em dobro",
  );
});

test("mapear rubrica de outra entidade e recusado pela coerencia", async () => {
  const { id: regimeId } = await fn.savePensionRegime({
    data: {
      tenant_id: tenantId,
      code: "RPPS3",
      name: "RPPS3",
      regime_type: "rpps",
      status: "ativo",
    },
    context: ctx(),
  });
  await assert.rejects(
    () =>
      fn.setPensionRegimeRubrics({
        data: {
          tenant_id: tenantId,
          pension_regime_id: regimeId,
          rubric_ids: [randomUUID()],
        },
        context: ctx(),
      }),
    /rubrica inválida/i,
  );
});
