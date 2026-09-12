/**
 * O1-03f — lancar o saldo apurado direto no banco de horas: teste de COMPORTAMENTO.
 *
 * postTimeBankFromApuracao apura a competencia (extras - faltas) e grava esse saldo
 * no banco de horas, sem redigitar. Um dia util com 60min de extra e um com 60min de
 * falta se anulam (saldo 0); com so o extra, o saldo do banco fica +60.
 *
 * Mutacao: gravar 0 (ou ignorar o saldo apurado) faz o banco nao refletir a
 * apuracao — derruba.
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
let unitId;
let linkId;
const tc = {};
const tb = {};

const dir = mkdtempSync(join(tmpdir(), "bank-from-apuracao-test-"));

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
  `export async function loadTenantAccess() { return { permissions: ["people.read","people.manage"] }; }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }`,
);
const auditStub = join(dir, "audit.mjs");
writeFileSync(auditStub, `export async function recordAudit() {}`);

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

async function punch(when) {
  await tc.recordTimeClockPunch({
    data: { tenant_id: tenantId, employment_link_id: linkId, punch_time: when },
    context: ctx(),
  });
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
  unitId = randomUUID();
  await db.query(
    "insert into public.unidades (id, tenant_id, codigo, nome, tipo, ativo) values ($1,$2,'U1','Unidade 1','setor',true)",
    [unitId, tenantId],
  );
  const personId = randomUUID();
  linkId = randomUUID();
  await db.query("insert into public.persons (id, full_name) values ($1,$2)", [
    personId,
    "Servidor Apuracao",
  ]);
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, registration_number, status, weekly_hours,
        unit_id, employment_type, work_regime, job_title, admission_date)
     values ($1,$2,$3,'MAT-A','ativo',40,$4,'efetivo','estatutario','Analista','2020-01-01')`,
    [linkId, tenantId, personId, unitId],
  );
  Object.assign(tc, await bundle("src/lib/time-clock.functions.ts", "tc.mjs"));
  Object.assign(tb, await bundle("src/lib/time-bank.functions.ts", "tb.mjs"));

  // 40h/sem -> 480 min/dia util. Terca 2025-06-10: 540 min (extra 60).
  await punch("2025-06-10T11:00:00.000Z"); // 08:00 SP
  await punch("2025-06-10T15:00:00.000Z"); // 12:00 SP
  await punch("2025-06-10T16:00:00.000Z"); // 13:00 SP
  await punch("2025-06-10T21:00:00.000Z"); // 18:00 SP -> 540 no dia (extra 60)
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("lancar apuracao no banco: saldo do banco reflete o extra apurado", async () => {
  const r = await tc.postTimeBankFromApuracao({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      reference_month: "2025-06",
    },
    context: ctx(),
  });
  assert.equal(r.minutes, 60); // extra 60 - falta 0
  assert.equal(r.balance_after, 60);

  // O razao do banco de horas mostra a competencia com +60.
  const bank = await tb.getTimeBank({
    data: { tenant_id: tenantId, employment_link_id: linkId },
    context: ctx(),
  });
  const jun = bank.entries.find((e) => e.reference_month === "2025-06");
  assert.ok(jun, "competencia nao lancada");
  assert.equal(jun.minutes, 60);
  assert.equal(jun.balance_after, 60);
});
