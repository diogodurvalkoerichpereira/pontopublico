/**
 * O4-01b (Onda 4 — Tributação) — resumo da arrecadação: COMPORTAMENTO.
 *
 * getTaxCreditsSummary consolida os créditos por situação, o total lançado, o arrecadado
 * (soma dos pagamentos) dos não cancelados e o a receber (saldo dos créditos em cobrança:
 * lancado + divida_ativa). Crédito cancelado não entra nos totais.
 *
 * Mutação: somar valor_lancado em vez de valor_pago no arrecadado, ou incluir cancelado
 * nos totais, derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "tax-summary-test-"));

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
async function seedCredit({ status, lancado, pago = 0 }) {
  seq += 1;
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',2026,'C','00000000000',$3,$4,$5,'2026-03-10',$6)`,
    [randomUUID(), tenantId, `INS-${seq}`, lancado, pago, status],
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
  Object.assign(fn, await bundle("src/lib/taxes.functions.ts", "tax.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("resume por situação, arrecadado e a receber; ignora cancelado", async () => {
  await seedCredit({ status: "lancado", lancado: 1000, pago: 0 });
  await seedCredit({ status: "divida_ativa", lancado: 500, pago: 100 });
  await seedCredit({ status: "quitado", lancado: 300, pago: 300 });
  await seedCredit({ status: "cancelado", lancado: 9000, pago: 0 });

  const r = await fn.getTaxCreditsSummary({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  assert.equal(r.porStatus.lancado, 1);
  assert.equal(r.porStatus.divida_ativa, 1);
  assert.equal(r.porStatus.quitado, 1);
  assert.equal(r.porStatus.cancelado, 1);

  // Lançado (não cancelado) = 1000 + 500 + 300 = 1800.
  assert.equal(r.valorLancado, 1800);
  // Arrecadado (pagamentos, não cancelado) = 0 + 100 + 300 = 400.
  assert.equal(r.arrecadado, 400);
  // A receber (lancado + divida_ativa) = 1000 + 400 = 1400.
  assert.equal(r.aReceber, 1400);
});
