/**
 * O1-09b (Onda 1) — amortização de consignação (Lei 10.820): COMPORTAMENTO.
 *
 * amortizeConsignment avança parcelas_pagas de uma consignação ATIVA sem passar do
 * total; ao alcançar o total, a consignação é quitada. Não amortiza consignação
 * quitada/cancelada. Confere o avanço, a quitação, o teto e a guarda de estado.
 *
 * Mutação: não quitar ao alcançar o total (fixar quitada=false) derruba o teste.
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
let personId;
let linkId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "consign-amortize-test-"));

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
  `const PERMS = ["people.read","people.manage"];
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

async function seedConsignment(total, pagas, status) {
  const id = randomUUID();
  await db.query(
    `insert into public.payroll_consignments
       (id, tenant_id, employment_link_id, tipo, consignatario, valor_parcela,
        parcelas_total, parcelas_pagas, status, inicio)
     values ($1,$2,$3,'emprestimo','Banco X',100,$4,$5,$6,'2026-01-01')`,
    [id, tenantId, linkId, total, pagas, status],
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
  personId = randomUUID();
  await db.query(
    "insert into public.persons (id, full_name) values ($1,'Servidor')",
    [personId],
  );
  linkId = randomUUID();
  await db.query(
    `insert into public.employment_links
       (id, tenant_id, person_id, registration_number, base_salary, status)
     values ($1,$2,$3,'REG1',5000,'rascunho')`,
    [linkId, tenantId, personId],
  );
  Object.assign(fn, await bundle("src/lib/consignments.functions.ts", "c.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const amortize = (id, parcelas) =>
  fn.amortizeConsignment({
    data: { tenant_id: tenantId, consignment_id: id, parcelas },
    context: ctx(),
  });

test("avança parcelas e quita ao alcançar o total; não passa do total", async () => {
  const c = await seedConsignment(3, 0, "ativa");

  const r1 = await amortize(c, 1);
  assert.equal(r1.parcelas_pagas, 1);
  assert.equal(r1.quitada, false);

  // 1 + 3 = 4 > 3: recusa.
  await assert.rejects(amortize(c, 3), /excede/i);

  // 1 + 2 = 3: quita.
  const r2 = await amortize(c, 2);
  assert.equal(r2.parcelas_pagas, 3);
  assert.equal(r2.quitada, true);

  const row = (
    await db.query(
      "select status from public.payroll_consignments where id=$1",
      [c],
    )
  ).rows[0];
  assert.equal(row.status, "quitada");

  // Quitada não amortiza mais.
  await assert.rejects(amortize(c, 1), /ativa/i);
});
