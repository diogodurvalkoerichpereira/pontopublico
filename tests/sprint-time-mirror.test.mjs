/**
 * O1-03c — espelho de ponto + comprovante: teste de COMPORTAMENTO.
 *
 * (1) PURO: `buildTimeMirror` pareia as marcacoes posicionalmente (1a=entrada,
 * 2a=saida...) e apura os minutos por dia, agrupando pelo dia local do ente; dia
 * com marca impar fica com intervalo aberto. (2) HANDLERS reais em PGlite:
 * `getTimeMirror` devolve a jornada apurada; `getPunchReceipt` devolve o
 * comprovante com NSR + codigo verificador (derivado do record_hash) e mascara o
 * CPF sem people.sensitive.read.
 *
 * Mutacao: somar todos os deltas em vez de pares, ou nao mascarar o CPF, derruba.
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
let mirror; // pure module
const fn = {};
let sensitive = false;

const dir = mkdtempSync(join(tmpdir(), "time-mirror-test-"));

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
  `export async function loadTenantAccess() {
     const perms = ["people.read","people.manage"];
     if (globalThis.__sensitive) perms.push("people.sensitive.read");
     return { permissions: perms };
   }
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
  Object.defineProperty(globalThis, "__sensitive", {
    get: () => sensitive,
    configurable: true,
  });
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
    "insert into public.persons (id, full_name, cpf) values ($1,'Servidor Ponto','52998224725')",
    [personId],
  );
  await db.query(
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status) values ($1,$2,$3,'MAT-9','rascunho')",
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

test("puro: buildTimeMirror pareia posicionalmente e apura minutos por dia", () => {
  // 4 marcas num dia de SP (08,12,13,17 local = 11,15,16,20 UTC): (12-8)+(17-13)=8h.
  const punches = [
    {
      nsr: 1,
      punchTime: "2025-06-02T11:00:00.000Z",
      recordHash: "a",
      source: "manual",
    },
    {
      nsr: 2,
      punchTime: "2025-06-02T15:00:00.000Z",
      recordHash: "b",
      source: "manual",
    },
    {
      nsr: 3,
      punchTime: "2025-06-02T16:00:00.000Z",
      recordHash: "c",
      source: "manual",
    },
    {
      nsr: 4,
      punchTime: "2025-06-02T20:00:00.000Z",
      recordHash: "d",
      source: "manual",
    },
  ];
  const { days, totalMinutes } = mirror.buildTimeMirror(punches);
  assert.equal(days.length, 1);
  assert.equal(days[0].date, "2025-06-02");
  assert.equal(days[0].workedMinutes, 480);
  assert.equal(days[0].intervals.length, 2);
  assert.equal(days[0].openInterval, false);
  assert.equal(totalMinutes, 480);
});

test("puro: marca impar deixa intervalo aberto e nao conta o pendente", () => {
  const punches = [
    {
      nsr: 1,
      punchTime: "2025-06-03T11:00:00.000Z",
      recordHash: "a",
      source: "manual",
    },
    {
      nsr: 2,
      punchTime: "2025-06-03T15:00:00.000Z",
      recordHash: "b",
      source: "manual",
    },
    {
      nsr: 3,
      punchTime: "2025-06-03T16:00:00.000Z",
      recordHash: "c",
      source: "manual",
    },
  ];
  const { days } = mirror.buildTimeMirror(punches);
  assert.equal(days[0].workedMinutes, 240); // so o primeiro par
  assert.equal(days[0].openInterval, true);
});

async function punch(when) {
  return fn.recordTimeClockPunch({
    data: { tenant_id: tenantId, employment_link_id: linkId, punch_time: when },
    context: ctx(),
  });
}

test("getTimeMirror devolve a jornada apurada das marcacoes gravadas", async () => {
  await punch("2025-06-10T11:00:00.000Z");
  await punch("2025-06-10T15:00:00.000Z");
  const result = await fn.getTimeMirror({
    data: { tenant_id: tenantId, employment_link_id: linkId },
    context: ctx(),
  });
  const day = result.days.find((d) => d.date === "2025-06-10");
  assert.ok(day, "dia nao apurado");
  assert.equal(day.workedMinutes, 240);
});

test("getPunchReceipt: NSR + codigo verificador; CPF mascarado sem permissao", async () => {
  const p = await punch("2025-06-11T12:00:00.000Z");
  const punchId = (
    await db.query(
      "select id from public.time_clock_punches where tenant_id=$1 and nsr=$2",
      [tenantId, p.nsr],
    )
  ).rows[0].id;

  sensitive = false;
  const masked = await fn.getPunchReceipt({
    data: { tenant_id: tenantId, punch_id: punchId },
    context: ctx(),
  });
  assert.equal(masked.nsr, p.nsr);
  assert.equal(
    masked.verification_code,
    p.recordHash.slice(0, 12).toUpperCase(),
  );
  assert.equal(masked.employee.registration_number, "MAT-9");
  assert.match(masked.employee.cpf, /^\*\*\*\.\*\*\*\.\*\*\*-25$/);

  sensitive = true;
  const full = await fn.getPunchReceipt({
    data: { tenant_id: tenantId, punch_id: punchId },
    context: ctx(),
  });
  assert.equal(full.employee.cpf, "52998224725");
});
