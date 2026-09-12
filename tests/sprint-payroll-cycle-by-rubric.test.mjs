/**
 * O1-04c (Onda 1) — Resumo da folha por rubrica (verba): COMPORTAMENTO.
 *
 * getPayrollCycleByRubric consolida, para um ciclo, o total de cada rubrica somando os
 * itens de cálculo da simulação de ORIGEM do ciclo (source_run_id), com quantos servidores
 * a receberam. Itens de outra simulação (outro run) não entram.
 *
 * Mutação: remover o filtro por run_id (somar itens de outra simulação) derruba o teste.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { build } from "esbuild";
import { createTestDb } from "./helpers/pglite.mjs";

let db;
let tenantId;
let userId;
const fn = {};
const R = {}; // rubric ids by code
const V = {}; // version ids by code
const L = {}; // link ids
const dir = mkdtempSync(join(tmpdir(), "cycle-by-rubric-test-"));

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
  `const PERMS = ["payroll.cycles.read","payroll.cycles.manage"];
   export async function loadTenantAccess() { return { permissions: PERMS }; }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }
   export function requireCriticalMfa() {}`,
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
const hex64 = (s) => createHash("sha256").update(s).digest("hex");

async function seedRubric(code, name, nature) {
  const id = randomUUID();
  await db.query(
    `insert into public.payroll_rubrics (id, tenant_id, code, name, nature, unit, status)
     values ($1,$2,$3,$4,$5,'valor','ativo')`,
    [id, tenantId, code, name, nature],
  );
  R[code] = id;
  const vid = randomUUID();
  await db.query(
    `insert into public.payroll_rubric_versions
       (id, tenant_id, rubric_id, version_number, valid_from, status)
     values ($1,$2,$3,1,'2020-01-01','rascunho')`,
    [vid, tenantId, id],
  );
  V[code] = vid;
}

async function seedLink(reg) {
  const person = randomUUID();
  await db.query("insert into public.persons(id,full_name) values($1,$2)", [
    person,
    `Serv ${reg}`,
  ]);
  await db.query(
    `insert into public.employment_links(tenant_id,person_id,source_profile_id,registration_number,status)
     values($1,$2,null,$3,'rascunho')`,
    [tenantId, person, reg],
  );
  L[reg] = (
    await db.query(
      "select id from public.employment_links where registration_number=$1 and tenant_id=$2",
      [reg, tenantId],
    )
  ).rows[0].id;
}

async function seedRun() {
  const id = randomUUID();
  await db.query(
    `insert into public.payroll_calculation_runs
       (id, tenant_id, reference_month, run_type, status, engine_version, input_checksum)
     values ($1,$2,'2026-05-01','simulacao','processando','v1',$3)`,
    [id, tenantId, hex64("run" + id)],
  );
  return id;
}

let seqItem = 0;
async function seedItem(runId, reg, code, amount) {
  seqItem += 1;
  await db.query(
    `insert into public.payroll_calculation_items
       (id, tenant_id, run_id, employment_link_id, rubric_id, version_id, sequence,
        amount, formula_checksum, memory)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb)`,
    [
      randomUUID(),
      tenantId,
      runId,
      L[reg],
      R[code],
      V[code],
      seqItem,
      amount,
      hex64(code + reg + amount),
    ],
  );
}

async function seedCycle(runId, month = "2026-05-01") {
  const id = randomUUID();
  await db.query(
    `insert into public.payroll_cycles (id, tenant_id, reference_month, source_run_id)
     values ($1,$2,$3,$4)`,
    [id, tenantId, month, runId],
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
  await seedRubric("VENC", "Vencimento", "provento");
  await seedRubric("INSS", "INSS", "desconto");
  await seedLink("M1");
  await seedLink("M2");
  Object.assign(
    fn,
    await bundle("src/lib/payroll-cycle.functions.ts", "cyc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("resumo por rubrica soma só os itens da simulação de origem", async () => {
  const run1 = await seedRun();
  await seedItem(run1, "M1", "VENC", 3000);
  await seedItem(run1, "M1", "INSS", 300);
  await seedItem(run1, "M2", "VENC", 2000);
  await seedItem(run1, "M2", "INSS", 200);
  // Outra simulação (não é a de origem do ciclo): não deve entrar.
  const run2 = await seedRun();
  await seedItem(run2, "M1", "VENC", 9999);

  const cycle = await seedCycle(run1);

  const r = await fn.getPayrollCycleByRubric({
    data: { tenant_id: tenantId, cycle_id: cycle },
    context: ctx(),
  });

  assert.equal(r.rubricas.length, 2);
  // Ordenado por natureza: desconto (INSS) antes de provento (VENC).
  assert.equal(r.rubricas[0].code, "INSS");
  assert.equal(r.rubricas[0].total, 500); // 300 + 200
  assert.equal(r.rubricas[0].beneficiarios, 2);
  assert.equal(r.rubricas[1].code, "VENC");
  assert.equal(r.rubricas[1].total, 5000); // 3000 + 2000, sem os 9999 do run2
  assert.equal(r.rubricas[1].beneficiarios, 2);
});

test("ciclo sem simulação de origem devolve lista vazia", async () => {
  const cycle = await seedCycle(null, "2026-06-01");
  const r = await fn.getPayrollCycleByRubric({
    data: { tenant_id: tenantId, cycle_id: cycle },
    context: ctx(),
  });
  assert.deepEqual(r.rubricas, []);
});
