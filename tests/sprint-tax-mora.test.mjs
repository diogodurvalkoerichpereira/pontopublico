/**
 * O4-06 (Onda 4) — encargos de mora do crédito tributário: COMPORTAMENTO.
 *
 * getUpdatedTaxDebt aplica, sobre o saldo devedor a partir do vencimento, multa de
 * mora (uma vez) e juros por mês ou fração (mês comercial de 30 dias). Confere: sem
 * encargos antes do vencimento; juros crescem com os meses de atraso; alíquotas do
 * ente entram no cálculo.
 *
 * Mutação: ignorar os meses de mora nos juros (fixar 1 mês) derruba o teste de atraso.
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

const dir = mkdtempSync(join(tmpdir(), "tax-mora-test-"));

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

let inscSeq = 0;
async function seedCredit(valorLancado, valorPago, vencimento) {
  inscSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',2026,'Contribuinte','00000000000',$3,$4,$5,$6,'lancado')`,
    [id, tenantId, `INSC-${inscSeq}`, valorLancado, valorPago, vencimento],
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
  Object.assign(fn, await bundle("src/lib/taxes.functions.ts", "tx.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const calc = (credit, ref, extra = {}) =>
  fn.getUpdatedTaxDebt({
    data: {
      tenant_id: tenantId,
      credit_id: credit,
      data_referencia: ref,
      ...extra,
    },
    context: ctx(),
  });

test("antes do vencimento não há encargos", async () => {
  const c = await seedCredit(1000, 0, "2026-01-31");
  const r = await calc(c, "2026-01-31"); // na data do vencimento
  assert.equal(r.multa, 0);
  assert.equal(r.juros, 0);
  assert.equal(r.valor_atualizado, 1000);
});

test("vencido: multa (uma vez) + juros por mês de mora, sobre o saldo", async () => {
  const c = await seedCredit(1000, 0, "2026-01-01");
  // 2026-01-01 -> 2026-03-02 = 60 dias -> ceil(60/30) = 2 meses de mora.
  const r = await calc(c, "2026-03-02");
  assert.equal(r.meses_mora, 2);
  assert.equal(r.multa, 20); // 2% de 1000, uma vez
  assert.equal(r.juros, 20); // 1%/mes * 2 meses de 1000
  assert.equal(r.valor_atualizado, 1040);
});

test("alíquotas do ente entram no cálculo; encargos sobre o saldo (não o lançado)", async () => {
  const c = await seedCredit(1000, 600, "2026-01-01"); // saldo 400
  const r = await calc(c, "2026-02-01", {
    multa_percent: 10,
    juros_mes_percent: 3,
  });
  // 2026-01-01 -> 2026-02-01 = 31 dias -> ceil(31/30) = 2 meses.
  assert.equal(r.saldo, 400);
  assert.equal(r.meses_mora, 2);
  assert.equal(r.multa, 40); // 10% de 400
  assert.equal(r.juros, 24); // 3% * 2 * 400
  assert.equal(r.valor_atualizado, 464);
});
