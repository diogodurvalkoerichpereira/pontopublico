/**
 * O2-xx (Onda 5) — aplicação de atos de pessoal programados: COMPORTAMENTO.
 *
 * saveEmploymentMovement registra um movimento com data de efeito futura como PENDENTE
 * (applied_at nulo, vínculo inalterado). applyDueEmploymentMovements, na data de referência,
 * aplica os pendentes já vencidos (effective_date ≤ referência) em ordem cronológica —
 * atualiza situação/lotação/desligamento do vínculo e carimba applied_at. Pendente futuro
 * não é aplicado.
 *
 * Mutação: aplicar sem a cláusula de vencimento (effective_date <= referência) aplicaria
 * também o movimento futuro — derruba.
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
let linkId;
let unitA;
let unitB;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "movement-apply-due-test-"));

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
  `const PERMS = ["movements.read","movements.manage"];
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

const ctx = () => ({ userId });
const iso = (d) => d.toISOString().slice(0, 10);

const linkStatus = async () =>
  (
    await db.query(
      "select status, unit_id from public.employment_links where id=$1",
      [linkId],
    )
  ).rows[0];

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
  unitA = randomUUID();
  unitB = randomUUID();
  await db.query(
    "insert into public.unidades (id, tenant_id, codigo, nome, ativo) values ($1,$2,'A','Unidade A',true),($3,$2,'B','Unidade B',true)",
    [unitA, tenantId, unitB],
  );
  await db.query(
    "insert into public.persons (id, full_name) values ($1,'Servidor')",
    [personId],
  );
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, registration_number, status, unit_id,
        employment_type, work_regime, job_title, weekly_hours, admission_date)
     values ($1,$2,$3,'MAT-M','ativo',$4,'efetivo','estatutario','Analista',40,'2024-01-01')`,
    [linkId, tenantId, personId, unitA],
  );
  Object.assign(fn, await bundle("src/lib/movement.functions.ts", "mov.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const save = (movement_type, effective_date, extra) =>
  fn.saveEmploymentMovement({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      movement_type,
      effective_date,
      legal_basis: "Portaria 1",
      ...extra,
    },
    context: ctx(),
  });
const applyDue = (data_referencia) =>
  fn.applyDueEmploymentMovements({
    data: { tenant_id: tenantId, data_referencia },
    context: ctx(),
  });

test("movimento futuro fica pendente e só é aplicado quando vence", async () => {
  const hoje = new Date();
  const daqui5 = new Date(hoje);
  daqui5.setDate(daqui5.getDate() + 5);
  const daqui10 = new Date(hoje);
  daqui10.setDate(daqui10.getDate() + 10);

  // Dois atos programados para o futuro → ambos pendentes ao registrar.
  const m1 = await save("afastamento", iso(daqui5));
  assert.equal(m1.applied, false);
  const m2 = await save("lotacao", iso(daqui10), { to_unit_id: unitB });
  assert.equal(m2.applied, false);

  // Nada aplicado ainda: vínculo intacto (ativo, unidade A).
  assert.deepEqual(await linkStatus(), { status: "ativo", unit_id: unitA });

  // Referência = daqui5: só o afastamento venceu; a lotação (daqui10) fica.
  const r = await applyDue(iso(daqui5));
  assert.equal(r.aplicados, 1);
  assert.deepEqual(await linkStatus(), { status: "afastado", unit_id: unitA });

  // O movimento futuro segue pendente; o já aplicado não reaparece.
  const pend = (
    await db.query(
      "select count(*)::int as n from public.employment_link_movements where applied_at is null",
    )
  ).rows[0].n;
  assert.equal(pend, 1);
  assert.equal((await applyDue(iso(daqui5))).aplicados, 0);

  // Quando a data da lotação chega, ela é aplicada (muda para unidade B).
  const r2 = await applyDue(iso(daqui10));
  assert.equal(r2.aplicados, 1);
  assert.equal((await linkStatus()).unit_id, unitB);
});
