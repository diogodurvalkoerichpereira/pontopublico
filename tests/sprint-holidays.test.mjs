/**
 * O1-03d — calendario de feriados + marcacao no espelho: teste de COMPORTAMENTO.
 *
 * PGlite com o esquema real. Prova: o seed nacional (fixos federais, tenant nulo)
 * existe; o CRUD do ente cadastra um feriado (com dedup por data); o espelho
 * (`getTimeMirror`) marca `isHoliday`/`holidayName` no dia — nacional recorrente e
 * feriado do ente por ano. Tambem: `buildTimeMirror` puro casa feriado fixo
 * (year nulo) em qualquer ano e feriado datado so no ano certo.
 *
 * Mutacao: casar feriado datado em qualquer ano, ou nao marcar o dia, derruba.
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
let mirror;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "holidays-test-"));

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

async function bundle(entry, name, plugins) {
  const out = join(dir, name);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
    external: ["node:*"],
    plugins,
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
  await db.query(
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status) values ($1,$2,$3,'MAT-H','rascunho')",
    [linkId, tenantId, personId],
  );

  mirror = await bundle("src/lib/time-mirror.ts", "mirror.mjs", []);
  Object.assign(
    fn,
    await bundle("src/lib/holidays.functions.ts", "hol.mjs", [stubPlugin()]),
  );
  Object.assign(
    fn,
    await bundle("src/lib/time-clock.functions.ts", "tc.mjs", [stubPlugin()]),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ userId });

test("puro: feriado fixo casa todo ano; datado so no ano certo", () => {
  const holidays = [
    { year: null, month: 12, day: 25, name: "Natal" },
    { year: 2025, month: 3, day: 4, name: "Carnaval 2025" },
  ];
  const punches = [
    {
      nsr: 1,
      punchTime: "2025-12-25T13:00:00.000Z",
      recordHash: "a",
      source: "manual",
    },
    {
      nsr: 2,
      punchTime: "2025-12-25T16:00:00.000Z",
      recordHash: "b",
      source: "manual",
    },
    {
      nsr: 3,
      punchTime: "2026-03-04T13:00:00.000Z",
      recordHash: "c",
      source: "manual",
    },
    {
      nsr: 4,
      punchTime: "2026-03-04T16:00:00.000Z",
      recordHash: "d",
      source: "manual",
    },
  ];
  const { days } = mirror.buildTimeMirror(punches, "UTC", holidays);
  const natal = days.find((d) => d.date === "2025-12-25");
  assert.equal(natal.isHoliday, true);
  assert.equal(natal.holidayName, "Natal");
  const carnaval2026 = days.find((d) => d.date === "2026-03-04");
  assert.equal(carnaval2026.isHoliday, false); // era so 2025
});

test("o seed nacional existe (fixos federais, tenant nulo)", async () => {
  const r = await fn.getHolidays({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  const natal = r.holidays.find((h) => h.month === 12 && h.day === 25);
  assert.ok(natal, "Natal nacional ausente");
  assert.equal(natal.tenant_id, null);
  assert.equal(natal.holiday_type, "nacional");
});

test("CRUD do ente cadastra feriado e recusa data duplicada", async () => {
  await fn.saveHoliday({
    data: {
      tenant_id: tenantId,
      name: "Aniversario do municipio",
      holiday_type: "municipal",
      month: 8,
      day: 15,
    },
    context: ctx(),
  });
  const r = await fn.getHolidays({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  assert.ok(
    r.holidays.find(
      (h) => h.month === 8 && h.day === 15 && h.tenant_id === tenantId,
    ),
  );
  await assert.rejects(
    () =>
      fn.saveHoliday({
        data: {
          tenant_id: tenantId,
          name: "Outro",
          holiday_type: "facultativo",
          month: 8,
          day: 15,
        },
        context: ctx(),
      }),
    /já existe feriado/i,
  );
});

test("getTimeMirror marca o feriado nacional no dia trabalhado", async () => {
  await fn.recordTimeClockPunch({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      punch_time: "2025-09-07T13:00:00.000Z",
    },
    context: ctx(),
  });
  await fn.recordTimeClockPunch({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      punch_time: "2025-09-07T16:00:00.000Z",
    },
    context: ctx(),
  });
  const result = await fn.getTimeMirror({
    data: { tenant_id: tenantId, employment_link_id: linkId, time_zone: "UTC" },
    context: ctx(),
  });
  const day = result.days.find((d) => d.date === "2025-09-07");
  assert.ok(day, "dia nao apurado");
  assert.equal(day.isHoliday, true);
  assert.equal(day.holidayName, "Independencia do Brasil");
});
