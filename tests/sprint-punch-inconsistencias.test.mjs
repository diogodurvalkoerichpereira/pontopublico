/**
 * O1-03h — marcacoes inconsistentes (intervalo em aberto): teste de COMPORTAMENTO.
 *
 * getPunchInconsistencies lista os dias com numero IMPAR de marcacoes (intervalo em
 * aberto) por vinculo ativo, no mes. Dia com marcacoes pareadas (par) NAO entra.
 * Vinculo desligado nao entra.
 *
 * Mutacao: trocar o filtro `day.openInterval` por incluir todo dia faz o dia pareado
 * aparecer e derruba; remover o filtro status='ativo' faz o desligado aparecer.
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
const link = {};
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "punch-inconsist-test-"));

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

async function makeLink(mat, status) {
  const personId = randomUUID();
  const id = randomUUID();
  await db.query("insert into public.persons (id, full_name) values ($1,$2)", [
    personId,
    `Servidor ${mat}`,
  ]);
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, registration_number, status, weekly_hours,
        unit_id, employment_type, work_regime, job_title, admission_date)
     values ($1,$2,$3,$4,$5,40,$6,'efetivo','estatutario','Analista','2020-01-01')`,
    [id, tenantId, personId, mat, status, unitId],
  );
  return id;
}

async function punch(id, when) {
  await fn.recordTimeClockPunch({
    data: { tenant_id: tenantId, employment_link_id: id, punch_time: when },
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
  Object.assign(fn, await bundle("src/lib/time-clock.functions.ts", "tc.mjs"));

  link.A = await makeLink("MAT-A", "ativo");
  link.B = await makeLink("MAT-B", "ativo");
  link.C = await makeLink("MAT-C", "desligado");

  // A, 2025-06-10: 3 marcacoes (IMPAR) -> intervalo em aberto. Inconsistente.
  await punch(link.A, "2025-06-10T11:00:00.000Z");
  await punch(link.A, "2025-06-10T15:00:00.000Z");
  await punch(link.A, "2025-06-10T16:00:00.000Z");
  // A, 2025-06-11: 2 marcacoes (PAR) -> consistente, nao entra.
  await punch(link.A, "2025-06-11T11:00:00.000Z");
  await punch(link.A, "2025-06-11T15:00:00.000Z");
  // B, 2025-06-12: 2 marcacoes (PAR) -> consistente.
  await punch(link.B, "2025-06-12T11:00:00.000Z");
  await punch(link.B, "2025-06-12T15:00:00.000Z");
  // C (desligado), 2025-06-10: 1 marcacao (IMPAR) -> nao pode aparecer (desligado).
  await punch(link.C, "2025-06-10T11:00:00.000Z");
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("inconsistencias: so dias impares de vinculo ativo", async () => {
  const r = await fn.getPunchInconsistencies({
    data: { tenant_id: tenantId, reference_month: "2025-06" },
    context: ctx(),
  });

  // Apenas A/2025-06-10 (3 marcacoes) e inconsistente.
  assert.equal(r.inconsistencias.length, 1);
  const it = r.inconsistencias[0];
  assert.equal(it.employment_link_id, link.A);
  assert.equal(it.date, "2025-06-10");
  assert.equal(it.punchCount, 3);

  // O dia PAR de A (06-11) e de B (06-12) nao entram; o desligado C tampouco.
  assert.equal(
    r.inconsistencias.some((i) => i.date === "2025-06-11"),
    false,
  );
  assert.equal(
    r.inconsistencias.some((i) => i.employment_link_id === link.B),
    false,
  );
  assert.equal(
    r.inconsistencias.some((i) => i.employment_link_id === link.C),
    false,
  );
});
