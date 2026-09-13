/**
 * O1-03h (Onda 5) — posição atual do banco de horas por vínculo: COMPORTAMENTO.
 *
 * getTimeBankBalances devolve, por vínculo, o saldo acumulado da ÚLTIMA competência lançada
 * (credor se positivo, devedor se negativo) e consolida credores × devedores e os minutos de
 * cada lado. Vínculo sem lançamento não aparece.
 *
 * Mutação: pegar a PRIMEIRA competência (order asc) em vez da última derruba o saldo atual.
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
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "time-bank-balances-test-"));

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

let seq = 0;
async function seedLink(nome) {
  seq += 1;
  const personId = randomUUID();
  const linkId = randomUUID();
  await db.query("insert into public.persons (id, full_name) values ($1,$2)", [
    personId,
    nome,
  ]);
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, registration_number, status, weekly_hours,
        unit_id, employment_type, work_regime, job_title, admission_date)
     values ($1,$2,$3,$4,'ativo',40,$5,'efetivo','estatutario','Analista','2020-01-01')`,
    [linkId, tenantId, personId, `MAT-${seq}`, unitId],
  );
  return linkId;
}
const post = (linkId, month, minutes) =>
  fn.postTimeBankEntry({
    data: {
      tenant_id: tenantId,
      employment_link_id: linkId,
      reference_month: month,
      minutes,
    },
    context: ctx(),
  });
const balances = () =>
  fn.getTimeBankBalances({ data: { tenant_id: tenantId }, context: ctx() });

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
  Object.assign(fn, await bundle("src/lib/time-bank.functions.ts", "tb.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("posição atual = saldo acumulado da última competência; separa credores e devedores", async () => {
  const credor = await seedLink("Servidor Credor");
  await post(credor, "2026-01", 120);
  await post(credor, "2026-02", 60); // acumulado 180

  const devedor = await seedLink("Servidor Devedor");
  await post(devedor, "2026-01", -90); // acumulado -90

  await seedLink("Servidor Sem Lançamento"); // não aparece

  const r = await balances();
  const byLink = new Map(r.balances.map((b) => [b.employment_link_id, b]));
  assert.equal(r.balances.length, 2);
  assert.equal(byLink.get(credor).saldo_minutes, 180);
  assert.equal(byLink.get(credor).reference_month, "2026-02");
  assert.equal(byLink.get(devedor).saldo_minutes, -90);

  assert.equal(r.totais.credores, 1);
  assert.equal(r.totais.devedores, 1);
  assert.equal(r.totais.saldo_positivo_min, 180);
  assert.equal(r.totais.saldo_negativo_min, -90);
  assert.equal(r.totais.saldo_liquido_min, 90);
});
