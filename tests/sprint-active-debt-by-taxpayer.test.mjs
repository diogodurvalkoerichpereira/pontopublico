/**
 * O4-14 (Onda 4 — Tributação) — consolidação de dívida ativa por contribuinte:
 * COMPORTAMENTO.
 *
 * getActiveDebtByTaxpayer junta as CDAs ao crédito de origem e agrupa por documento do
 * contribuinte: total inscrito e recorte por situação. O saldo em cobrança considera SÓ
 * as CDAs 'ativa'. Seeda dois contribuintes com CDAs ativa/quitada/cancelada e confere
 * os subtotais e o saldo consolidado.
 *
 * Mutação: somar quitada/cancelada no saldo em cobrança (ignorar o filter status='ativa')
 * derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "active-debt-taxpayer-test-"));

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
async function seedCda({ contribuinte, documento, valor, status }) {
  seq += 1;
  const creditId = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, vencimento, status)
     values ($1,$2,'IPTU',2026,$3,$4,$5,$6,'2026-03-10','divida_ativa')`,
    [creditId, tenantId, contribuinte, documento, `INS-${seq}`, valor],
  );
  await db.query(
    `insert into public.active_debt_certificates
       (id, tenant_id, exercicio, numero, credit_id, valor_inscrito,
        data_inscricao, status)
     values ($1,$2,2026,$3,$4,$5,'2026-06-01',$6)`,
    [randomUUID(), tenantId, seq, creditId, valor, status],
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
    await bundle("src/lib/active-debt-certificate.functions.ts", "cda.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("consolida por contribuinte e o saldo em cobrança só conta CDA ativa", async () => {
  // Contribuinte A (doc 111): 2 ativas (100 + 200 = 300) + 1 quitada (50).
  await seedCda({
    contribuinte: "Empresa A",
    documento: "111",
    valor: 100,
    status: "ativa",
  });
  await seedCda({
    contribuinte: "Empresa A",
    documento: "111",
    valor: 200,
    status: "ativa",
  });
  await seedCda({
    contribuinte: "Empresa A",
    documento: "111",
    valor: 50,
    status: "quitada",
  });
  // Contribuinte B (doc 222): 1 ativa (80) + 1 cancelada (40).
  await seedCda({
    contribuinte: "Empresa B",
    documento: "222",
    valor: 80,
    status: "ativa",
  });
  await seedCda({
    contribuinte: "Empresa B",
    documento: "222",
    valor: 40,
    status: "cancelada",
  });

  const r = await fn.getActiveDebtByTaxpayer({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  const a = r.contribuintes.find((c) => c.contribuinte_documento === "111");
  const b = r.contribuintes.find((c) => c.contribuinte_documento === "222");

  assert.equal(a.qtd_cdas, 3);
  assert.equal(a.total_inscrito, 350);
  assert.equal(a.total_ativa, 300);
  assert.equal(a.total_quitada, 50);

  assert.equal(b.qtd_cdas, 2);
  assert.equal(b.total_ativa, 80);
  assert.equal(b.total_cancelada, 40);

  // Saldo em cobrança: só as ativas (300 + 80), sem quitada/cancelada.
  assert.equal(r.saldoEmCobranca, 380);
});
