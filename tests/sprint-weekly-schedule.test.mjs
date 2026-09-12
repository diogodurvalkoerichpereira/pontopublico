/**
 * O1-03f (parte 2) — escala semanal customizada por vinculo: teste de COMPORTAMENTO.
 *
 * (1) INTEGRACAO: sem escala custom, sabado tem previsto 0 (padrao por weekly_hours),
 * entao trabalho no sabado vira extra. Com escala custom que preve sabado, o mesmo
 * trabalho fica dentro do previsto (sem extra). (2) ROUNDTRIP: save/get devolve a
 * escala custom (flag custom=true, minutos batem).
 *
 * Mutacao: expectedByWeekdayFor ignorar a escala (cair sempre no padrao) faz o
 * sabado voltar a previsto 0 e o extra reaparecer — derruba.
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
const ws = {};

const dir = mkdtempSync(join(tmpdir(), "weekly-schedule-test-"));

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
    "Servidor Escala",
  ]);
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, registration_number, status, weekly_hours,
        unit_id, employment_type, work_regime, job_title, admission_date)
     values ($1,$2,$3,'MAT-A','ativo',40,$4,'efetivo','estatutario','Analista','2020-01-01')`,
    [linkId, tenantId, personId, unitId],
  );
  Object.assign(tc, await bundle("src/lib/time-clock.functions.ts", "tc.mjs"));
  Object.assign(
    ws,
    await bundle("src/lib/work-schedule.functions.ts", "ws.mjs"),
  );

  // Sabado 2025-06-14: 08:00-12:00 SP (11:00-15:00 UTC) = 240 min.
  for (const when of ["2025-06-14T11:00:00.000Z", "2025-06-14T15:00:00.000Z"]) {
    await tc.recordTimeClockPunch({
      data: {
        tenant_id: tenantId,
        employment_link_id: linkId,
        punch_time: when,
      },
      context: ctx(),
    });
  }
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

async function apurarSabado() {
  const r = await tc.getTimeApuracao({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      from: "2025-06-01T00:00:00.000Z",
      to: "2025-06-30T23:59:59.000Z",
    },
    context: ctx(),
  });
  return r.days.find((d) => d.date === "2025-06-14");
}

test("sem escala custom: sabado tem previsto 0 e o trabalho vira extra", async () => {
  const dia = await apurarSabado();
  assert.ok(dia, "sabado nao apurado");
  assert.equal(dia.weekday, 6); // sabado
  assert.equal(dia.expectedMinutes, 0);
  assert.equal(dia.workedMinutes, 240);
  assert.equal(dia.extraMinutes, 240);
});

test("com escala custom que preve sabado: mesmo trabalho fica dentro do previsto", async () => {
  // [dom..sab]: sabado (indice 6) = 240; demais 0 para isolar o efeito.
  await ws.saveEmploymentWeeklySchedule({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      minutes: [0, 0, 0, 0, 0, 0, 240],
    },
    context: ctx(),
  });

  const dia = await apurarSabado();
  assert.equal(dia.expectedMinutes, 240);
  assert.equal(dia.workedMinutes, 240);
  assert.equal(dia.extraMinutes, 0);
  assert.equal(dia.faltaMinutes, 0);

  // Roundtrip: get devolve a escala custom.
  const g = await ws.getEmploymentWeeklySchedules({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  const s = g.servidores.find((x) => x.employment_link_id === linkId);
  assert.equal(s.custom, true);
  assert.deepEqual(s.minutes, [0, 0, 0, 0, 0, 0, 240]);
});
