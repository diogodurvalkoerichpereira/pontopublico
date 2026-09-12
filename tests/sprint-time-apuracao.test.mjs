/**
 * O1-03e — apuracao de jornada (previsto x trabalhado, tolerancia, extras/faltas):
 * teste de COMPORTAMENTO.
 *
 * (1) PURO: apurarJornada aplica o previsto por dia da semana, zera o previsto no
 * feriado (todo trabalho vira extra), desconsidera desvio dentro da tolerancia
 * legal e conta extras/faltas acima dela. (2) HANDLER real em PGlite:
 * getTimeApuracao puxa a jornada semanal do vinculo + feriados + marcacoes e apura.
 *
 * Mutacao: ignorar a tolerancia, ou dar previsto no feriado, derruba.
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

const dir = mkdtempSync(join(tmpdir(), "apuracao-test-"));

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
  // 40h/semana -> 480 min/dia util (seg-sex).
  await db.query(
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status, weekly_hours) values ($1,$2,$3,'MAT-A','rascunho',40)",
    [linkId, tenantId, personId],
  );
  mirror = await bundle("src/lib/time-mirror.ts", "mirror.mjs", []);
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

// Config: 480 min seg-sex, 0 fim de semana; tolerancia 10 min/dia.
function config() {
  return {
    expectedMinutesByWeekday: mirror.defaultExpectedByWeekday(40),
    toleranceMinutesPerDay: 10,
  };
}

function mday(date, workedMinutes, isHoliday = false) {
  return {
    date,
    punches: [],
    intervals: [],
    workedMinutes,
    openInterval: false,
    isHoliday,
    holidayName: isHoliday ? "Feriado" : null,
  };
}

test("puro: dia cheio bate o previsto; desvio na tolerancia nao gera extra/falta", () => {
  // 2025-06-10 e terca (dia util). 485 min: desvio +5 <= 10 -> tolerancia.
  const r = mirror.apurarJornada([mday("2025-06-10", 485)], config());
  assert.equal(r.days[0].expectedMinutes, 480);
  assert.equal(r.days[0].withinTolerance, true);
  assert.equal(r.days[0].extraMinutes, 0);
  assert.equal(r.days[0].faltaMinutes, 0);
});

test("puro: acima da tolerancia gera extra; abaixo gera falta", () => {
  const extraDay = mirror.apurarJornada([mday("2025-06-10", 540)], config());
  assert.equal(extraDay.days[0].extraMinutes, 60); // 540-480
  assert.equal(extraDay.days[0].faltaMinutes, 0);
  const faltaDay = mirror.apurarJornada([mday("2025-06-10", 400)], config());
  assert.equal(faltaDay.days[0].faltaMinutes, 80); // 480-400
  assert.equal(faltaDay.days[0].extraMinutes, 0);
});

test("puro: feriado em dia util tem previsto 0 e todo trabalho vira extra", () => {
  // 2025-05-01 (Dia do Trabalho) e quinta — dia util, mas feriado zera o previsto.
  const r = mirror.apurarJornada([mday("2025-05-01", 300, true)], config());
  assert.equal(r.days[0].weekday, 4); // quinta
  assert.equal(r.days[0].expectedMinutes, 0);
  assert.equal(r.days[0].extraMinutes, 300);
  assert.equal(r.days[0].faltaMinutes, 0);
});

test("puro: fim de semana tem previsto 0", () => {
  // 2025-06-08 e domingo.
  const r = mirror.apurarJornada([mday("2025-06-08", 0)], config());
  assert.equal(r.days[0].weekday, 0);
  assert.equal(r.days[0].expectedMinutes, 0);
});

test("getTimeApuracao puxa a jornada do vinculo e apura o periodo", async () => {
  // Terca 2025-06-10, 8h de trabalho (08-12,13-17 local SP = 11-15,16-20 UTC).
  for (const when of [
    "2025-06-10T11:00:00.000Z",
    "2025-06-10T15:00:00.000Z",
    "2025-06-10T16:00:00.000Z",
    "2025-06-10T20:00:00.000Z",
  ]) {
    await fn.recordTimeClockPunch({
      data: {
        tenant_id: tenantId,
        employment_link_id: linkId,
        punch_time: when,
      },
      context: ctx(),
    });
  }
  const r = await fn.getTimeApuracao({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      from: "2025-06-01T00:00:00.000Z",
      to: "2025-06-30T23:59:59.000Z",
    },
    context: ctx(),
  });
  const day = r.days.find((d) => d.date === "2025-06-10");
  assert.ok(day, "dia nao apurado");
  assert.equal(day.expectedMinutes, 480);
  assert.equal(day.workedMinutes, 480);
  assert.equal(day.withinTolerance, true);
  assert.equal(r.totals.expectedMinutes, 480);
});
