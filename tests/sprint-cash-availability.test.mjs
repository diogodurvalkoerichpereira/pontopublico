/**
 * O2-12 (Onda 2) — disponibilidade de caixa: COMPORTAMENTO.
 *
 * getCashAvailability consolida o saldo das contas ativas e o fluxo do período
 * (ingressos, saídas, fluxo líquido), separando as transferências internas.
 * Confere o saldo consolidado, os totais por tipo e o filtro de período.
 *
 * Mutação: contar 'saida' como ingresso (remover o filtro por tipo) derruba.
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

const dir = mkdtempSync(join(tmpdir(), "cash-test-"));

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

function stubPlugin() {
  return {
    name: "stub",
    setup(b) {
      const map = [
        [/@tanstack\/react-start$/, startStub],
        [/(^|\/)db\.server$/, dbStub],
        [/(^|\/)data\.functions$/, dataStub],
        [/(^|\/)tenant-access\.server$/, taStub],
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

async function seedAccount(nome, saldo) {
  const id = randomUUID();
  await db.query(
    `insert into public.treasury_accounts (id, tenant_id, nome, tipo, saldo_atual)
     values ($1,$2,$3,'banco',$4)`,
    [id, tenantId, nome, saldo],
  );
  return id;
}
async function seedMovement(accountId, tipo, valor, data) {
  await db.query(
    `insert into public.treasury_movements
       (id, tenant_id, account_id, tipo, data_movimento, valor, historico, saldo_apos)
     values ($1,$2,$3,$4,$5,$6,'mov',0)`,
    [randomUUID(), tenantId, accountId, tipo, data, valor],
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
  Object.assign(
    fn,
    await bundle("src/lib/cash-availability.functions.ts", "c.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("consolida saldos e separa ingressos, saídas e transferências", async () => {
  const a = await seedAccount("Conta A", 700);
  const b = await seedAccount("Conta B", 300);
  await seedMovement(a, "ingresso", 1000, "2026-03-05");
  await seedMovement(a, "saida", 300, "2026-03-06");
  await seedMovement(a, "transferencia_saida", 200, "2026-03-07");
  await seedMovement(b, "transferencia_entrada", 200, "2026-03-07");
  // Fora do período (não deve contar em março).
  await seedMovement(a, "ingresso", 999, "2026-04-01");

  const r = await fn.getCashAvailability({
    data: { tenant_id: tenantId, from: "2026-03-01", to: "2026-03-31" },
    context: ctx(),
  });
  assert.equal(r.saldo_consolidado, 1000); // 700 + 300
  assert.equal(r.ingressos, 1000);
  assert.equal(r.saidas, 300);
  assert.equal(r.fluxo_liquido, 700);
  assert.equal(r.transferencias_entrada, 200);
  assert.equal(r.transferencias_saida, 200);
  assert.equal(r.contas.length, 2);
});

test("sem período soma tudo", async () => {
  const r = await fn.getCashAvailability({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  // Agora inclui o ingresso de abril (999) além do de março (1000).
  assert.equal(r.ingressos, 1999);
});
