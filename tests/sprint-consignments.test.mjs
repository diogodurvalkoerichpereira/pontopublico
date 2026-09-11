/**
 * O1-09 (Onda 1) — consignações e margem consignável (Lei 10.820): COMPORTAMENTO.
 *
 * registerConsignment só inclui se a parcela couber na margem (35% da base);
 * cancelConsignment libera a margem. Confere o teto de 35%, a recusa acima da
 * margem e a liberação ao cancelar.
 *
 * Mutação: ignorar o comprometido (só comparar a parcela ao teto cheio) derruba.
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
let personId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "consign-test-"));

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
  `const PERMS = ["people.read","people.manage"];
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

async function seedLink(baseSalary, registro) {
  const id = randomUUID();
  // status 'rascunho' evita o gatilho de validação de vínculo ativo (que exige
  // lotação/regime/jornada); a margem só recusa vínculo 'desligado'.
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, registration_number, base_salary, status)
     values ($1,$2,$3,$4,$5,'rascunho')`,
    [id, tenantId, personId, registro, baseSalary],
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
  personId = randomUUID();
  await db.query(
    "insert into public.persons (id, full_name) values ($1,'Servidor')",
    [personId],
  );
  Object.assign(fn, await bundle("src/lib/consignments.functions.ts", "c.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const registra = (linkId, valor, extra = {}) =>
  fn.registerConsignment({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      tipo: "emprestimo",
      consignatario: "Banco Y",
      valor_parcela: valor,
      parcelas_total: 12,
      inicio: "2026-03-01",
      ...extra,
    },
    context: ctx(),
  });

test("margem de 35%: acumula até o teto e recusa acima", async () => {
  // base 1000 → margem 350.
  const link = await seedLink(1000, "M-1");
  const r1 = await registra(link, 200);
  assert.equal(r1.margem, 350);
  assert.equal(r1.disponivel, 150);
  // +150 chega ao teto exato.
  const r2 = await registra(link, 150);
  assert.equal(r2.disponivel, 0);
  // +0.01 estoura.
  await assert.rejects(registra(link, 0.01), /margem consignável/);

  const margin = await fn.getConsignmentMargin({
    data: { tenant_id: tenantId, employment_link_id: link },
    context: ctx(),
  });
  assert.equal(margin.margem, 350);
  assert.equal(margin.comprometido, 350);
  assert.equal(margin.disponivel, 0);
  assert.equal(margin.consignments.length, 2);
});

test("deposita o total consignado ativo na folha da competência", async () => {
  const link = await seedLink(2000, "M-3"); // margem 700
  await registra(link, 300);
  await registra(link, 150);
  // Uma consignação já quitada (parcelas_pagas == total) não entra no depósito.
  await db.query(
    `insert into public.payroll_consignments
       (id, tenant_id, employment_link_id, tipo, consignatario, valor_parcela,
        parcelas_total, parcelas_pagas, status, inicio)
     values ($1,$2,$3,'outro','X',100,12,12,'ativa','2026-01-01')`,
    [randomUUID(), tenantId, link],
  );
  const rubricId = randomUUID();
  await db.query(
    `insert into public.payroll_rubrics (id, tenant_id, code, name, nature, unit)
     values ($1,$2,'CONS','Consignacoes','desconto','valor')`,
    [rubricId, tenantId],
  );
  const r = await fn.depositConsignmentsToPayroll({
    data: {
      tenant_id: tenantId,
      employment_link_id: link,
      reference_month: "2026-03",
      rubric_id: rubricId,
    },
    context: ctx(),
  });
  assert.equal(r.total, 450); // 300 + 150 (quitada de 100 fora)
  const mv = (
    await db.query(
      `select amount::text from public.payroll_monthly_variables
       where employment_link_id=$1 and rubric_id=$2 and reference_month='2026-03-01'`,
      [link, rubricId],
    )
  ).rows;
  assert.equal(mv.length, 1);
  assert.equal(mv[0].amount, "450.00");

  // Re-depositar substitui, não duplica.
  await fn.depositConsignmentsToPayroll({
    data: {
      tenant_id: tenantId,
      employment_link_id: link,
      reference_month: "2026-03",
      rubric_id: rubricId,
    },
    context: ctx(),
  });
  const again = (
    await db.query(
      `select count(*)::int as n from public.payroll_monthly_variables
       where employment_link_id=$1 and rubric_id=$2 and reference_month='2026-03-01'`,
      [link, rubricId],
    )
  ).rows[0].n;
  assert.equal(again, 1);
});

test("rubrica de provento é recusada no depósito de consignação", async () => {
  const link = await seedLink(2000, "M-4");
  await registra(link, 100);
  const rubricId = randomUUID();
  await db.query(
    `insert into public.payroll_rubrics (id, tenant_id, code, name, nature, unit)
     values ($1,$2,'PROV','Provento','provento','valor')`,
    [rubricId, tenantId],
  );
  await assert.rejects(
    fn.depositConsignmentsToPayroll({
      data: {
        tenant_id: tenantId,
        employment_link_id: link,
        reference_month: "2026-03",
        rubric_id: rubricId,
      },
      context: ctx(),
    }),
    /desconto/,
  );
});

test("cancelar libera a margem", async () => {
  const link = await seedLink(1000, "M-2");
  const r = await registra(link, 300);
  assert.equal(r.disponivel, 50);
  await fn.cancelConsignment({
    data: { tenant_id: tenantId, consignment_id: r.id },
    context: ctx(),
  });
  // Depois de cancelar, a margem toda volta a caber.
  const r2 = await registra(link, 340);
  assert.equal(r2.disponivel, 10);
});
