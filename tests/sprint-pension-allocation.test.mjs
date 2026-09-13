/**
 * O1-10b (Onda 5) — rateio da pensão por morte na competência: COMPORTAMENTO.
 *
 * getPensionAllocation lista os pensionistas vigentes na data (valid_from ≤ ref e (valid_to
 * nulo ou ≥ ref)) de um vínculo, soma o percentual e sinaliza rateio completo (=100%) ou
 * incompleto (<100%). Pensionista fora da vigência não entra. (O teto de 100% já é imposto
 * por trigger na gravação, então rateio_excedido é defensivo e não semeável aqui.)
 *
 * Mutação: ignorar o fim de vigência (contar pensionista expirado) infla o total — derruba.
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

const dir = mkdtempSync(join(tmpdir(), "pension-alloc-test-"));

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
  `export async function loadTenantAccess() { return { permissions: ["family.read","family.manage"] }; }
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

let seq = 0;
async function seedLink() {
  seq += 1;
  const holderId = randomUUID();
  const linkId = randomUUID();
  await db.query("insert into public.persons(id,full_name) values($1,$2)", [
    holderId,
    `Instituidor ${seq}`,
  ]);
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, source_profile_id, registration_number, status)
     values ($1,$2,$3,null,$4,'rascunho')`,
    [linkId, tenantId, holderId, `MAT-${seq}`],
  );
  return { holderId, linkId };
}
async function seedBeneficiary(linkId, pct, from, to) {
  const benId = randomUUID();
  await db.query("insert into public.persons(id,full_name) values($1,$2)", [
    benId,
    "Pensionista",
  ]);
  await db.query(
    `insert into public.pension_beneficiaries
       (id, tenant_id, employment_link_id, beneficiary_person_id, calculation_type,
        percentage, fixed_amount, priority, valid_from, valid_to)
     values ($1,$2,$3,$4,'percentual',$5,null,1,$6,$7)`,
    [randomUUID(), tenantId, linkId, benId, pct, from, to],
  );
}
const alloc = (holderId, linkId) =>
  fn.getPensionAllocation({
    data: {
      tenant_id: tenantId,
      holder_person_id: holderId,
      employment_link_id: linkId,
      data_referencia: "2026-06-01",
    },
    context: ctx(),
  });

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
  Object.assign(fn, await bundle("src/lib/family.functions.ts", "fam.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("rateio completo (100%) ignora pensionista fora de vigência", async () => {
  const { holderId, linkId } = await seedLink();
  await seedBeneficiary(linkId, 60, "2026-01-01", null);
  await seedBeneficiary(linkId, 40, "2026-01-01", null);
  await seedBeneficiary(linkId, 30, "2025-01-01", "2025-12-31"); // expirado: fora

  const r = await alloc(holderId, linkId);
  assert.equal(r.beneficiaries.length, 2);
  assert.equal(r.total_percentual, 100);
  assert.equal(r.rateio_completo, true);
  assert.equal(r.rateio_excedido, false);
});

test("rateio incompleto (<100%) é sinalizado", async () => {
  const incompleto = await seedLink();
  await seedBeneficiary(incompleto.linkId, 60, "2026-01-01", null);
  const ri = await alloc(incompleto.holderId, incompleto.linkId);
  assert.equal(ri.total_percentual, 60);
  assert.equal(ri.rateio_completo, false);
  assert.equal(ri.rateio_excedido, false);
});
