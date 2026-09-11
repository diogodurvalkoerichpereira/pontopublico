/**
 * O4-11 (Onda 4) — rescisão do parcelamento por inadimplência: COMPORTAMENTO.
 *
 * rescindInstallmentPlan rescinde o plano ativo quando há pelo menos `limite_atraso`
 * parcelas vencidas e não pagas na data de referência; abaixo disso recusa; um plano já
 * rescindido/quitado não rescinde. Confere o limiar, a contagem e a guarda de estado.
 *
 * Mutação: inverter o limiar de inadimplência (< → >=) derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "installment-rescission-test-"));

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
// Cria um plano ativo com N parcelas cujos vencimentos são as datas informadas.
async function seedPlan(vencimentos) {
  seq += 1;
  const creditId = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',2026,'C','00000000000',$3,1200,0,'2026-01-01','divida_ativa')`,
    [creditId, tenantId, `INSC-${seq}`],
  );
  const planId = randomUUID();
  await db.query(
    `insert into public.tax_installment_plans
       (id, tenant_id, credit_id, numero_parcelas, valor_total, data_acordo, status)
     values ($1,$2,$3,$4,1200,'2026-01-01','ativo')`,
    [planId, tenantId, creditId, vencimentos.length],
  );
  let n = 0;
  for (const venc of vencimentos) {
    n += 1;
    await db.query(
      `insert into public.tax_installments
         (id, tenant_id, plan_id, numero, valor, vencimento, status)
       values ($1,$2,$3,$4,100,$5,'aberta')`,
      [randomUUID(), tenantId, planId, n, venc],
    );
  }
  return planId;
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
    await bundle("src/lib/tax-installments.functions.ts", "ti.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const rescind = (plan) =>
  fn.rescindInstallmentPlan({
    data: {
      tenant_id: tenantId,
      plan_id: plan,
      data_referencia: "2026-06-01",
    },
    context: ctx(),
  });

test("rescinde com 3+ parcelas vencidas; abaixo do limiar recusa", async () => {
  // 2 vencidas (antes de 2026-06-01) + 1 futura: só 2 < 3 → recusa.
  const poucas = await seedPlan(["2026-02-01", "2026-03-01", "2026-12-01"]);
  await assert.rejects(rescind(poucas), /inadimplência/i);

  // 3 vencidas → rescinde.
  const muitas = await seedPlan(["2026-02-01", "2026-03-01", "2026-04-01"]);
  const r = await rescind(muitas);
  assert.equal(r.status, "rescindido");
  assert.equal(r.parcelas_vencidas, 3);

  const row = (
    await db.query(
      "select status from public.tax_installment_plans where id=$1",
      [muitas],
    )
  ).rows[0];
  assert.equal(row.status, "rescindido");

  // Plano já rescindido não rescinde de novo.
  await assert.rejects(rescind(muitas), /ativo/i);
});
