/**
 * O1-03f — banco de horas persistente: teste de COMPORTAMENTO.
 *
 * postTimeBankEntry lanca o saldo do mes (minutes, com sinal) e recalcula o saldo
 * ACUMULADO (balance_after) de todas as competencias do vinculo, EM ORDEM de
 * competencia — mesmo quando os meses sao lancados fora de ordem, e mesmo ao
 * retificar um mes no meio (os seguintes reordenam). getTimeBank le o razao.
 *
 * Mutacao: recalcular sem `order by reference_month` (na ordem de insercao) quebra
 * o acumulado quando se lanca fora de ordem; nao recalcular apos retificar deixa o
 * acumulado defasado. Ambas derrubam.
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
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "time-bank-test-"));

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
    "Servidor Banco",
  ]);
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, registration_number, status, weekly_hours,
        unit_id, employment_type, work_regime, job_title, admission_date)
     values ($1,$2,$3,'MAT-A','ativo',40,$4,'efetivo','estatutario','Analista','2020-01-01')`,
    [linkId, tenantId, personId, unitId],
  );
  Object.assign(fn, await bundle("src/lib/time-bank.functions.ts", "tb.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

async function post(month, minutes) {
  return fn.postTimeBankEntry({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      reference_month: month,
      minutes,
    },
    context: ctx(),
  });
}

async function ledger() {
  const r = await fn.getTimeBank({
    data: { tenant_id: tenantId, employment_link_id: linkId },
    context: ctx(),
  });
  return r.entries;
}

test("acumulado recalculado em ordem de competencia, mesmo lancando fora de ordem", async () => {
  // Lanca MARCO (+120) primeiro, depois JANEIRO (+60), depois FEVEREIRO (-30).
  await post("2025-03", 120);
  await post("2025-01", 60);
  const r = await post("2025-02", -30);
  // O retorno ja traz o acumulado ate fevereiro: 60 + (-30) = 30.
  assert.equal(r.balance_after, 30);

  const l = await ledger();
  assert.deepEqual(
    l.map((e) => [e.reference_month, e.minutes, e.balance_after]),
    [
      ["2025-01", 60, 60],
      ["2025-02", -30, 30],
      ["2025-03", 120, 150],
    ],
  );
});

test("retificar um mes no meio reordena os acumulados seguintes", async () => {
  // Fevereiro passa de -30 para -90. Jan=60 (60), Fev=-90 (-30), Mar=120 (90).
  const r = await post("2025-02", -90);
  assert.equal(r.balance_after, -30);

  const l = await ledger();
  assert.deepEqual(
    l.map((e) => [e.reference_month, e.balance_after]),
    [
      ["2025-01", 60],
      ["2025-02", -30],
      ["2025-03", 90],
    ],
  );
  // Nao duplicou linha ao retificar (upsert por competencia).
  assert.equal(l.length, 3);
});
