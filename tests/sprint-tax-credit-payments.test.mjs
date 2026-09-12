/**
 * O4-01d (Onda 4) — extrato (razão) de pagamentos do crédito tributário:
 * COMPORTAMENTO.
 *
 * getTaxCreditPayments lista os pagamentos de um crédito em ordem cronológica, com
 * o saldo devedor APÓS cada um (lançado − Σpago), e consolida total pago e saldo.
 * Não vaza pagamentos de outro crédito.
 *
 * Mutação: somar em vez de subtrair no saldo após, ou vazar pagamentos de outro
 * crédito, derruba.
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

const dir = mkdtempSync(join(tmpdir(), "tax-payments-test-"));

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
  `const PERMS = ["taxes.read","taxes.manage"];
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

let seq = 0;
async function seedCredit(lancado) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',2026,'C','00000000000',$3,$4,0,'2026-03-10','lancado')`,
    [id, tenantId, `INS-${seq}`, lancado],
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
  Object.assign(fn, await bundle("src/lib/taxes.functions.ts", "tax.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

async function pay(creditId, valor, data) {
  return fn.recordTaxPayment({
    data: {
      tenant_id: tenantId,
      credit_id: creditId,
      valor,
      data_pagamento: data,
    },
    context: ctx(),
  });
}

test("extrato: pagamentos cronológicos com saldo devedor após cada um", async () => {
  const c = await seedCredit(1000);
  const outro = await seedCredit(500);
  // Dois pagamentos no crédito c e um pagamento no outro (não deve vazar).
  await pay(c, 300, "2026-03-01");
  await pay(c, 200, "2026-04-01");
  await pay(outro, 100, "2026-03-15");

  const r = await fn.getTaxCreditPayments({
    data: { tenant_id: tenantId, credit_id: c },
    context: ctx(),
  });

  assert.equal(r.pagamentos.length, 2); // só os do crédito c
  assert.equal(r.valor_lancado, 1000);
  // Cronológico: março (300) então abril (200).
  assert.deepEqual(
    r.pagamentos.map((p) => [p.data_pagamento, p.valor, p.saldo_apos]),
    [
      ["2026-03-01", 300, 700], // 1000 - 300
      ["2026-04-01", 200, 500], // 1000 - 500
    ],
  );
  assert.equal(r.total_pago, 500);
  assert.equal(r.saldo, 500);
});
