/**
 * O1-05c (Onda 1) — Alerta de limite do período concessivo de férias (CLT art. 134/137):
 * COMPORTAMENTO.
 *
 * getVacationDeadlineAlerts lista os períodos aquisitivos ainda devidos (taken_days <
 * entitled_days, status vivo) cujo concession_deadline já venceu (< referência → risco de
 * dobra) ou vence dentro da janela de alerta. Período já gozado, ou fora da janela, não entra.
 *
 * Mutação: inverter a comparação do "vencido" (< → >) troca a contagem de vencidos e derruba;
 * remover o filtro taken_days < entitled_days inclui um período já quitado e também derruba.
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
let policyId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "vacation-deadline-test-"));

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
  `const PERMS = ["vacation.read","vacation.manage"];
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

let seq = 0;
async function seedPeriod({
  accrualStart,
  accrualEnd,
  deadline,
  entitled = 30,
  taken = 0,
  status = "disponivel",
}) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.vacation_accrual_periods
       (id,tenant_id,employment_link_id,policy_id,accrual_start,accrual_end,
        concession_deadline,entitled_days,taken_days,status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      tenantId,
      linkId,
      policyId,
      accrualStart,
      accrualEnd,
      deadline,
      entitled,
      taken,
      status,
    ],
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
  const person = randomUUID();
  await db.query(
    "insert into public.persons(id,full_name) values($1,'Servidor X')",
    [person],
  );
  await db.query(
    `insert into public.employment_links(tenant_id,person_id,source_profile_id,registration_number,status)
     values($1,$2,null,'M1','rascunho')`,
    [tenantId, person],
  );
  linkId = (
    await db.query(
      "select id from public.employment_links where registration_number='M1' and tenant_id=$1",
      [tenantId],
    )
  ).rows[0].id;
  policyId = randomUUID();
  await db.query(
    `insert into public.vacation_policies(id,tenant_id,name,effective_from) values($1,$2,'Padrão','2020-01-01')`,
    [policyId, tenantId],
  );
  Object.assign(fn, await bundle("src/lib/vacation.functions.ts", "vac.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("classifica vencidos e a vencer; ignora gozados e fora da janela", async () => {
  // Referência 2026-06-01, janela 60 dias (até 2026-07-31).
  // Vencido: limite 2026-03-01 (< ref), devido.
  const vencido = await seedPeriod({
    accrualStart: "2023-01-01",
    accrualEnd: "2023-12-31",
    deadline: "2026-03-01",
  });
  // A vencer: limite 2026-07-01 (dentro da janela), devido.
  const aVencer = await seedPeriod({
    accrualStart: "2024-01-01",
    accrualEnd: "2024-12-31",
    deadline: "2026-07-01",
  });
  // Fora da janela: limite 2026-10-01 (> ref+60).
  await seedPeriod({
    accrualStart: "2025-01-01",
    accrualEnd: "2025-12-31",
    deadline: "2026-10-01",
  });
  // Vencido mas já totalmente gozado (taken == entitled): não alerta.
  await seedPeriod({
    accrualStart: "2022-01-01",
    accrualEnd: "2022-12-31",
    deadline: "2026-02-01",
    taken: 30,
    status: "gozado",
  });
  // Status ainda 'disponivel' porém sem saldo (taken == entitled) e vencido:
  // o filtro taken_days < entitled_days o exclui (não alerta).
  await seedPeriod({
    accrualStart: "2021-01-01",
    accrualEnd: "2021-12-31",
    deadline: "2026-01-15",
    taken: 30,
    status: "disponivel",
  });

  const r = await fn.getVacationDeadlineAlerts({
    data: {
      tenant_id: tenantId,
      data_referencia: "2026-06-01",
      dias_alerta: 60,
    },
    context: ctx(),
  });

  assert.equal(r.alerts.length, 2);
  assert.equal(r.vencidos, 1);
  assert.equal(r.aVencer, 1);
  // Ordenado por concession_deadline: vencido primeiro.
  assert.equal(r.alerts[0].id, vencido);
  assert.equal(r.alerts[0].vencido, true);
  assert.equal(r.alerts[1].id, aVencer);
  assert.equal(r.alerts[1].vencido, false);
});
