/**
 * O2-11b (Onda 2) — Extrato (razão) de conta de tesouraria: COMPORTAMENTO.
 *
 * getTreasuryLedger lista os movimentos de UMA conta no período, em ordem cronológica, com
 * o saldo após cada lançamento, e consolida entradas (ingresso + transferência recebida) e
 * saídas (saída + transferência enviada). Isolado por account_id.
 *
 * Mutação: classificar transferencia_entrada como saída (ou não somá-la em entradas)
 * derruba; vazar movimentos de outra conta também.
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

const dir = mkdtempSync(join(tmpdir(), "treasury-ledger-test-"));

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
async function seedAccount() {
  accSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.treasury_accounts (id, tenant_id, nome, tipo)
     values ($1,$2,$3,'banco')`,
    [id, tenantId, `Conta ${accSeq}`],
  );
  return id;
}

async function seedMovement(accountId, tipo, data, valor, saldoApos) {
  await db.query(
    `insert into public.treasury_movements
       (id, tenant_id, account_id, tipo, data_movimento, valor, historico, saldo_apos)
     values ($1,$2,$3,$4,$5,$6,'mov',$7)`,
    [randomUUID(), tenantId, accountId, tipo, data, valor, saldoApos],
  );
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
  Object.assign(fn, await bundle("src/lib/treasury.functions.ts", "tre.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("extrato cronológico e isolado, com entradas e saídas do período", async () => {
  const a = await seedAccount();
  const b = await seedAccount();
  // Conta A: ingresso 1000, saída 300, transferência recebida 200 → saldo 900.
  await seedMovement(a, "ingresso", "2026-03-01", 1000, 1000);
  await seedMovement(a, "saida", "2026-03-05", 300, 700);
  await seedMovement(a, "transferencia_entrada", "2026-03-10", 200, 900);
  // Conta B: não pode aparecer no extrato de A.
  await seedMovement(b, "ingresso", "2026-03-02", 5000, 5000);

  const r = await fn.getTreasuryLedger({
    data: { tenant_id: tenantId, account_id: a },
    context: ctx(),
  });

  assert.equal(r.movements.length, 3);
  // Ordem cronológica.
  assert.equal(r.movements[0].data_movimento, "2026-03-01");
  assert.equal(r.movements[2].data_movimento, "2026-03-10");
  assert.equal(r.movements[2].saldo_apos, "900.00");
  // Entradas = ingresso 1000 + transferência 200; saídas = 300. Nada da conta B.
  assert.equal(r.entradas, 1200);
  assert.equal(r.saidas, 300);
});
