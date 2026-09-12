/**
 * O2-11 (Onda 2) — tesouraria: COMPORTAMENTO (ponta a ponta).
 *
 * recordTreasuryMovement soma o ingresso e subtrai a saída (nunca negativa);
 * transferBetweenAccounts move o saldo entre contas de forma atômica. Confere o
 * saldo após cada movimento, a recusa de saída maior que o saldo e a transferência.
 *
 * Mutação: permitir saldo negativo na saída derruba.
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

const dir = mkdtempSync(join(tmpdir(), "treasury-test-"));

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

const criaConta = (nome) =>
  fn.saveTreasuryAccount({
    data: { tenant_id: tenantId, nome, tipo: "banco" },
    context: ctx(),
  });
const move = (accountId, tipo, valor) =>
  fn.recordTreasuryMovement({
    data: {
      tenant_id: tenantId,
      account_id: accountId,
      tipo,
      data_movimento: "2026-03-01",
      valor,
      historico: "Movimento",
    },
    context: ctx(),
  });

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
  Object.assign(fn, await bundle("src/lib/treasury.functions.ts", "t.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("ingresso soma, saída subtrai e não deixa saldo negativo", async () => {
  const { id } = await criaConta("Conta Movimento");
  const r1 = await move(id, "ingresso", 1000);
  assert.equal(r1.saldo_atual, 1000);
  const r2 = await move(id, "saida", 300);
  assert.equal(r2.saldo_atual, 700);
  // Saída maior que o saldo é recusada.
  await assert.rejects(move(id, "saida", 800), /negativo/);
  // O saldo permaneceu em 700.
  const row = (
    await db.query(
      "select saldo_atual::text from public.treasury_accounts where id=$1",
      [id],
    )
  ).rows[0];
  assert.equal(row.saldo_atual, "700.00");
});

test("transferência move o saldo entre contas atomicamente", async () => {
  const origem = (await criaConta("Origem")).id;
  const destino = (await criaConta("Destino")).id;
  await move(origem, "ingresso", 500);
  const t = await fn.transferBetweenAccounts({
    data: {
      tenant_id: tenantId,
      origem_id: origem,
      destino_id: destino,
      data_movimento: "2026-03-02",
      valor: 200,
      historico: "Transferencia",
    },
    context: ctx(),
  });
  assert.equal(t.saldo_origem, 300);
  assert.equal(t.saldo_destino, 200);

  // Transferência acima do saldo da origem é recusada (e nada muda).
  await assert.rejects(
    fn.transferBetweenAccounts({
      data: {
        tenant_id: tenantId,
        origem_id: origem,
        destino_id: destino,
        data_movimento: "2026-03-03",
        valor: 999,
        historico: "Excesso",
      },
      context: ctx(),
    }),
    /negativo/,
  );
});
