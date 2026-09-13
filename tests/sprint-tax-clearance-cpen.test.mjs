/**
 * O4-03b (Onda 5) — regularidade com ressalva por parcelamento (CTN art. 151/206):
 * COMPORTAMENTO.
 *
 * checkTaxClearance marca como `suspenso` o débito com parcelamento ATIVO (exigibilidade
 * suspensa). Se todos os débitos em aberto estão suspensos → situação "regular_com_ressalva"
 * (base da CPEN); se há ao menos um exigível → "com_debitos". Parcelamento rescindido não
 * suspende.
 *
 * Mutação: contar qualquer plano (sem o filtro status='ativo') faz um plano rescindido
 * suspender o débito — derruba.
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

const dir = mkdtempSync(join(tmpdir(), "cpen-test-"));

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
async function seedCredit(doc, lancado, pago) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',2026,'Fulano',$3,$4,$5,$6,'2026-05-01','divida_ativa')`,
    [id, tenantId, doc, `INSC-${seq}`, lancado, pago],
  );
  return id;
}
async function seedPlan(creditId, status) {
  await db.query(
    `insert into public.tax_installment_plans
       (id, tenant_id, credit_id, numero_parcelas, valor_total, data_acordo, status)
     values ($1,$2,$3,12,1000,'2026-02-01',$4)`,
    [randomUUID(), tenantId, creditId, status],
  );
}
const check = (doc) =>
  fn.checkTaxClearance({
    data: { tenant_id: tenantId, contribuinte_documento: doc },
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
  Object.assign(
    fn,
    await bundle("src/lib/tax-clearance.functions.ts", "tc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("todos os débitos parcelados → regular com ressalva (CPEN)", async () => {
  const c = await seedCredit("DOCA", 1000, 200); // saldo 800
  await seedPlan(c, "ativo");
  const r = await check("DOCA");
  assert.equal(r.situacao, "regular_com_ressalva");
  assert.equal(r.saldo_total, 800);
  assert.equal(r.saldo_suspenso, 800);
  assert.equal(r.debts[0].suspenso, true);
});

test("um débito exigível ao lado de um parcelado → com débitos", async () => {
  const parcelado = await seedCredit("DOCB", 500, 0);
  await seedPlan(parcelado, "ativo");
  await seedCredit("DOCB", 300, 0); // exigível, sem plano
  const r = await check("DOCB");
  assert.equal(r.situacao, "com_debitos");
  assert.equal(r.saldo_total, 800);
  assert.equal(r.saldo_suspenso, 500);
});

test("parcelamento rescindido não suspende → com débitos", async () => {
  const c = await seedCredit("DOCC", 400, 0);
  await seedPlan(c, "rescindido");
  const r = await check("DOCC");
  assert.equal(r.situacao, "com_debitos");
  assert.equal(r.saldo_suspenso, 0);
  assert.equal(r.debts[0].suspenso, false);
});
