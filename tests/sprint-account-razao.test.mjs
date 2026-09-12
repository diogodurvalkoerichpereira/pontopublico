/**
 * O2-05b (Onda 2) — Razão de uma conta contábil (livro razão, PCASP): COMPORTAMENTO.
 *
 * getAccountLedger lista, em ordem cronológica, os lançamentos que tocaram UMA conta no
 * exercício, com o saldo corrente após cada um (Σdébito − Σcrédito) e os totais. Linha de
 * outra conta não entra.
 *
 * Mutação: inverter o sinal do lado no saldo corrente (débito subtrai / crédito soma), ou
 * remover o filtro pela conta, derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "account-razao-test-"));

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

// Cria um lançamento com uma linha (D/C) numa conta.
async function seedEntry({ data_lancamento, conta, lado, valor }) {
  const entryId = randomUUID();
  await db.query(
    `insert into public.accounting_entries
       (id, tenant_id, exercicio, data_lancamento, historico, source, valor)
     values ($1,$2,2026,$3,'lancamento','manual',$4)`,
    [entryId, tenantId, data_lancamento, valor],
  );
  await db.query(
    `insert into public.accounting_entry_lines (id, tenant_id, entry_id, conta, lado, valor)
     values ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), tenantId, entryId, conta, lado, valor],
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
    await bundle("src/lib/accounting-read.functions.ts", "acc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("razão cronológico com saldo corrente, isolado por conta", async () => {
  // Conta 1.1.1.1: crédito 300 em 02-01 e débito 1000 em 03-01 (inseridos fora de ordem).
  await seedEntry({
    data_lancamento: "2026-03-01",
    conta: "1.1.1.1",
    lado: "D",
    valor: 1000,
  });
  await seedEntry({
    data_lancamento: "2026-02-01",
    conta: "1.1.1.1",
    lado: "C",
    valor: 300,
  });
  // Outra conta: não entra no razão de 1.1.1.1.
  await seedEntry({
    data_lancamento: "2026-02-15",
    conta: "2.2.2.2",
    lado: "D",
    valor: 5000,
  });

  const r = await fn.getAccountLedger({
    data: { tenant_id: tenantId, exercicio: 2026, conta: "1.1.1.1" },
    context: ctx(),
  });

  assert.equal(r.linhas.length, 2);
  // Ordem cronológica: crédito 02-01 primeiro (saldo -300), depois débito 03-01 (saldo 700).
  assert.equal(r.linhas[0].data_lancamento, "2026-02-01");
  assert.equal(r.linhas[0].lado, "C");
  assert.equal(r.linhas[0].saldo, -300);
  assert.equal(r.linhas[1].data_lancamento, "2026-03-01");
  assert.equal(r.linhas[1].saldo, 700); // -300 + 1000
  assert.equal(r.debito, 1000);
  assert.equal(r.credito, 300);
  assert.equal(r.saldo, 700); // sem os 5000 da outra conta
});
