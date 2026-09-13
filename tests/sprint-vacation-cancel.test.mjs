/**
 * O1-05d (Onda 5) — cancelamento de agendamento de férias + trava do depósito: COMPORTAMENTO.
 *
 * cancelVacation cancela um agendamento ainda não pago (programado/aprovado), e o trigger
 * de validação (que exclui frações 'cancelado') libera o saldo de dias — reagendar o
 * período inteiro volta a caber. depositVacationToPayroll passa a mover o agendamento para
 * 'pago', o que trava o cancelamento (não se libera o saldo com a folha já paga) e recusa
 * depositar um agendamento cancelado.
 *
 * Mutação: manter o agendamento em 'programado' após o depósito (não gravar 'pago') deixa
 * cancelar um agendamento já depositado — derruba.
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
let rubricId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "vacation-cancel-test-"));

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
  `const PERMS = ["vacation.read","vacation.manage","payroll.assignments.manage"];
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

const genPeriod = () =>
  fn.generateVacationPeriod({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      accrual_start: "2024-01-01",
    },
    context: ctx(),
  });
const schedule = (periodId, start, days) =>
  fn.scheduleVacation({
    data: {
      tenant_id: tenantId,
      accrual_period_id: periodId,
      start_date: start,
      days,
    },
    context: ctx(),
  });
const cancel = (id) =>
  fn.cancelVacation({
    data: { tenant_id: tenantId, schedule_id: id, motivo: "Remarcado" },
    context: ctx(),
  });
const statusOf = async (id) =>
  (
    await db.query("select status from public.vacation_schedules where id=$1", [
      id,
    ])
  ).rows[0].status;

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
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status, base_salary) values ($1,$2,$3,'MAT-V','rascunho',3000)",
    [linkId, tenantId, personId],
  );
  rubricId = randomUUID();
  await db.query(
    `insert into public.payroll_rubrics
       (id, tenant_id, code, name, nature, unit, calculation_order, status, created_by)
     values ($1,$2,'FER','Ferias','provento','valor',20,'ativo',$3)`,
    [rubricId, tenantId, userId],
  );
  Object.assign(fn, await bundle("src/lib/vacation.functions.ts", "vac.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("cancelar libera o saldo de dias; agendamento pago não cancela", async () => {
  const { id: periodId } = await genPeriod();

  // Agenda 20 dos 30 dias.
  const s1 = await schedule(periodId, "2025-06-02", 20);
  assert.equal(await statusOf(s1.id), "programado");

  // Sem cancelar, agendar mais 20 estouraria o saldo (só restam 10).
  await assert.rejects(schedule(periodId, "2025-08-01", 20), /saldo/i);

  // Cancela o primeiro: o saldo dos 30 dias volta a ficar livre.
  const c = await cancel(s1.id);
  assert.equal(c.status, "cancelado");
  assert.equal(await statusOf(s1.id), "cancelado");
  const s2 = await schedule(periodId, "2025-09-01", 30);
  assert.equal(await statusOf(s2.id), "programado");

  // Deposita s2 na folha → vira 'pago'.
  await fn.depositVacationToPayroll({
    data: {
      tenant_id: tenantId,
      schedule_id: s2.id,
      vacation_rubric_id: rubricId,
    },
    context: ctx(),
  });
  assert.equal(await statusOf(s2.id), "pago");

  // Pago não cancela (a folha já saiu).
  await assert.rejects(cancel(s2.id), /pago|programado ou aprovado/i);

  // E não se deposita um agendamento cancelado.
  await assert.rejects(
    fn.depositVacationToPayroll({
      data: {
        tenant_id: tenantId,
        schedule_id: s1.id,
        vacation_rubric_id: rubricId,
      },
      context: ctx(),
    }),
    /cancelado/i,
  );
});
