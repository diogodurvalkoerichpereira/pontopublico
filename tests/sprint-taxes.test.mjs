/**
 * O4-01 (Onda 4) — tributos: lançamento, arrecadação, dívida ativa: COMPORTAMENTO.
 *
 * launchTaxCredit lança o crédito; recordTaxPayment arrecada (nunca acima do saldo,
 * quita quando zera); inscribeDividaAtiva inscreve o vencido não pago. Confere o
 * saldo, a quitação e a inscrição.
 *
 * Mutação: não somar ao pago, ou permitir inscrever antes do vencimento, derruba.
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

const dir = mkdtempSync(join(tmpdir(), "taxes-test-"));

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
const launch = (inscricao, valor, vencimento) =>
  fn.launchTaxCredit({
    data: {
      tenant_id: tenantId,
      tributo: "IPTU",
      exercicio: 2026,
      contribuinte: "Fulano",
      contribuinte_documento: "123.456.789-00",
      inscricao,
      valor_lancado: valor,
      vencimento,
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
  Object.assign(fn, await bundle("src/lib/taxes.functions.ts", "t.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("arrecadação reduz o saldo e quita quando zera", async () => {
  const { id } = await launch("INSC-1", 1000, "2026-03-31");
  let r = await fn.recordTaxPayment({
    data: {
      tenant_id: tenantId,
      credit_id: id,
      data_pagamento: "2026-02-10",
      valor: 400,
    },
    context: ctx(),
  });
  assert.equal(r.saldo, 600);
  assert.equal(r.quitado, false);
  r = await fn.recordTaxPayment({
    data: {
      tenant_id: tenantId,
      credit_id: id,
      data_pagamento: "2026-03-10",
      valor: 600,
    },
    context: ctx(),
  });
  assert.equal(r.saldo, 0);
  assert.equal(r.quitado, true);
  // Quitado não aceita novo pagamento.
  await assert.rejects(
    fn.recordTaxPayment({
      data: {
        tenant_id: tenantId,
        credit_id: id,
        data_pagamento: "2026-04-10",
        valor: 1,
      },
      context: ctx(),
    }),
    /quitado/,
  );
});

test("pagamento acima do saldo é recusado", async () => {
  const { id } = await launch("INSC-2", 500, "2026-03-31");
  await assert.rejects(
    fn.recordTaxPayment({
      data: {
        tenant_id: tenantId,
        credit_id: id,
        data_pagamento: "2026-02-10",
        valor: 501,
      },
      context: ctx(),
    }),
    /excede o saldo/,
  );
});

test("inscrição em dívida ativa só de vencido com saldo", async () => {
  const { id } = await launch("INSC-3", 800, "2026-03-31");
  // Antes do vencimento: recusa.
  await assert.rejects(
    fn.inscribeDividaAtiva({
      data: {
        tenant_id: tenantId,
        credit_id: id,
        data_referencia: "2026-03-01",
      },
      context: ctx(),
    }),
    /ainda não está vencido/,
  );
  // Vencido: inscreve.
  const r = await fn.inscribeDividaAtiva({
    data: { tenant_id: tenantId, credit_id: id, data_referencia: "2026-06-01" },
    context: ctx(),
  });
  assert.equal(r.status, "divida_ativa");
});
