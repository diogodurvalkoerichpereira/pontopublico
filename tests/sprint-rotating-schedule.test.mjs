/**
 * O1-03f (parte 3) — escala rotativa (ciclo de N dias) por vinculo: teste de
 * COMPORTAMENTO.
 *
 * (1) PURO: expectedMinutesForRotating indexa o dia certo do ciclo, inclusive
 * para datas ANTES da ancora (modulo sempre nao-negativo). (2) INTEGRACAO: um
 * vinculo com jornada semanal (previsto 40h seg-sex) recebe uma escala rotativa
 * de ciclo 2 (trabalha/folga) que muda o previsto do MESMO dia (uma terca-feira,
 * dia par do ciclo = trabalho 480min) — a rotativa GANHA da semanal.
 * (3) ROUNDTRIP: save/get devolve a escala; delete remove e a apuracao volta a
 * usar a semanal.
 *
 * Mutacao: apurarJornada ignorar `rotatingSchedule` (cair sempre no
 * expectedMinutesByWeekday) faz o previsto do dia par do ciclo virar 0
 * (a terca cai fora do seg-sex do fallback semanal simulado) — derruba (2).
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
const mirror = {};

const dir = mkdtempSync(join(tmpdir(), "rotating-schedule-test-"));

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
    "Servidor Rotativo",
  ]);
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, registration_number, status, weekly_hours,
        unit_id, employment_type, work_regime, job_title, admission_date)
     values ($1,$2,$3,'MAT-R','ativo',40,$4,'efetivo','estatutario','Analista','2020-01-01')`,
    [linkId, tenantId, personId, unitId],
  );
  Object.assign(tc, await bundle("src/lib/time-clock.functions.ts", "tc.mjs"));
  Object.assign(
    ws,
    await bundle("src/lib/work-schedule.functions.ts", "ws.mjs"),
  );
  Object.assign(mirror, await bundle("src/lib/time-mirror.ts", "mirror.mjs"));

  // Terca-feira 2025-06-17: 08:00-16:00 SP (11:00-19:00 UTC) = 480 min.
  for (const when of ["2025-06-17T11:00:00.000Z", "2025-06-17T19:00:00.000Z"]) {
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

test("puro: expectedMinutesForRotating indexa o dia do ciclo, inclusive antes da ancora", () => {
  const schedule = { cycle_start_date: "2025-06-16", minutes_by_day: [480, 0] };
  // Ancora (dia 0): trabalho.
  assert.equal(mirror.expectedMinutesForRotating(schedule, "2025-06-16"), 480);
  // Dia seguinte (dia 1): folga.
  assert.equal(mirror.expectedMinutesForRotating(schedule, "2025-06-17"), 0);
  // Dois dias depois: volta ao dia 0 do ciclo (par).
  assert.equal(mirror.expectedMinutesForRotating(schedule, "2025-06-18"), 480);
  // Um dia ANTES da ancora: equivale ao ultimo dia do ciclo (indice 1, modulo
  // sempre nao-negativo).
  assert.equal(mirror.expectedMinutesForRotating(schedule, "2025-06-15"), 0);
});

async function apurarTerca() {
  const r = await tc.getTimeApuracao({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      from: "2025-06-01T00:00:00.000Z",
      to: "2025-06-30T23:59:59.000Z",
    },
    context: ctx(),
  });
  return r.days.find((d) => d.date === "2025-06-17");
}

test("sem escala rotativa: previsto vem do padrao por weekly_hours (seg-sex)", async () => {
  const dia = await apurarTerca();
  assert.ok(dia, "terca nao apurada");
  assert.equal(dia.weekday, 2); // terca
  // 40h/5 dias = 480 min previstos seg-sex pelo padrao.
  assert.equal(dia.expectedMinutes, 480);
  assert.equal(dia.extraMinutes, 0);
});

test("com escala rotativa: o previsto do dia vem do ciclo, nao da semana", async () => {
  // Ciclo de 2 dias ANCORADO na propria terca (2025-06-17) como dia 0 = folga
  // (0 min); dia 1 = trabalho (480 min). O teste anterior provou que, SEM escala
  // rotativa, essa mesma terca tem previsto 480 pelo padrao semanal (seg-sex) —
  // agora, com a rotativa dizendo 0 para o mesmo dia, o previsto muda: prova que
  // a rotativa GANHA da semanal (sem isso, o mutante que ignora
  // `rotatingSchedule` manteria 480 e o teste cairia).
  await ws.saveEmploymentRotatingSchedule({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      cycle_start_date: "2025-06-17",
      minutes_by_day: [0, 480],
    },
    context: ctx(),
  });

  const dia = await apurarTerca();
  assert.equal(dia.expectedMinutes, 0);
  assert.equal(dia.workedMinutes, 480);
  assert.equal(dia.extraMinutes, 480);
  assert.equal(dia.faltaMinutes, 0);

  // Roundtrip: get devolve a escala rotativa.
  const g = await ws.getEmploymentRotatingSchedules({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  const s = g.servidores.find((x) => x.employment_link_id === linkId);
  assert.ok(s.rotating, "escala rotativa nao encontrada no get");
  assert.equal(s.rotating.cycle_start_date, "2025-06-17");
  assert.equal(s.rotating.cycle_length_days, 2);
  assert.deepEqual(s.rotating.minutes_by_day, [0, 480]);
});

test("remover a escala rotativa: apuracao volta a usar o padrao semanal", async () => {
  await ws.deleteEmploymentRotatingSchedule({
    data: { tenant_id: tenantId, employment_link_id: linkId },
    context: ctx(),
  });
  const dia = await apurarTerca();
  assert.equal(dia.expectedMinutes, 480); // padrao seg-sex, de novo

  const g = await ws.getEmploymentRotatingSchedules({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  const s = g.servidores.find((x) => x.employment_link_id === linkId);
  assert.equal(s.rotating, null);

  await assert.rejects(
    () =>
      ws.deleteEmploymentRotatingSchedule({
        data: { tenant_id: tenantId, employment_link_id: linkId },
        context: ctx(),
      }),
    /nao tem escala rotativa|não tem escala rotativa/,
  );
});
