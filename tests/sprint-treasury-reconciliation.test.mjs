/**
 * O2-15 (Onda 2) — conciliação bancária: COMPORTAMENTO.
 *
 * reconcileTreasuryAccount registra a diferença = saldo do extrato − saldo do
 * livro (saldo_atual da conta), uma por conta/data. Confere o cálculo da
 * diferença e a recusa de conciliação duplicada.
 *
 * Mutação: inverter para livro − extrato derruba o sinal da diferença.
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
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "treasury-recon-test-"));

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
  `const PERMS = ["accounting.read","accounting.manage"];
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

let accSeq = 0;
async function seedAccount(saldo) {
  accSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.treasury_accounts (id, tenant_id, nome, tipo, saldo_atual)
     values ($1,$2,$3,$4,$5)`,
    [id, tenantId, `Conta ${accSeq}`, "banco", saldo],
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
  Object.assign(
    fn,
    await bundle("src/lib/treasury-reconciliation.functions.ts", "tr.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("diferença = extrato − livro; não concilia duas vezes na mesma data", async () => {
  const acc = await seedAccount(1000);
  const r = await fn.reconcileTreasuryAccount({
    data: {
      tenant_id: tenantId,
      account_id: acc,
      data_referencia: "2026-03-31",
      saldo_extrato: 1200, // 1200 - 1000 = 200
    },
    context: ctx(),
  });
  assert.equal(r.saldo_livro, 1000);
  assert.equal(r.diferenca, 200);

  const row = (
    await db.query(
      "select diferenca::text from public.treasury_reconciliations where id=$1",
      [r.id],
    )
  ).rows[0];
  assert.equal(row.diferenca, "200.00");

  // Mesma conta/data não concilia de novo.
  await assert.rejects(
    fn.reconcileTreasuryAccount({
      data: {
        tenant_id: tenantId,
        account_id: acc,
        data_referencia: "2026-03-31",
        saldo_extrato: 1300,
      },
      context: ctx(),
    }),
    /já existe conciliação/i,
  );
});

test("extrato menor que o livro gera diferença negativa", async () => {
  const acc = await seedAccount(500);
  const r = await fn.reconcileTreasuryAccount({
    data: {
      tenant_id: tenantId,
      account_id: acc,
      data_referencia: "2026-04-30",
      saldo_extrato: 450, // 450 - 500 = -50
    },
    context: ctx(),
  });
  assert.equal(r.diferenca, -50);
});
