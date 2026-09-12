/**
 * O4-13 (Onda 4) — cancelamento de crédito tributário (isenção/anistia/remissão):
 * COMPORTAMENTO.
 *
 * cancelTaxCredit cancela um crédito que não esteja quitado nem já cancelado, e recusa
 * se houver parcelamento ativo (deve ser rescindido antes). Confere o cancelamento, a
 * guarda de estado e a trava do parcelamento ativo.
 *
 * Mutação: aceitar cancelar crédito quitado (remover a guarda) derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "tax-cancel-test-"));

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
async function seedCredit(status, pago = 0) {
  inscSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',2026,'C','00000000000',$3,1000,$4,'2026-01-01',$5)`,
    [id, tenantId, `INSC-${inscSeq}`, pago, status],
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

const cancel = (id) =>
  fn.cancelTaxCredit({
    data: {
      tenant_id: tenantId,
      credit_id: id,
      motivo: "Isencao concedida por lei",
      data_cancelamento: "2026-06-01",
    },
    context: ctx(),
  });

test("cancela crédito não quitado; quitado recusa", async () => {
  const lancado = await seedCredit("lancado");
  const r = await cancel(lancado);
  assert.equal(r.status, "cancelado");

  const row = (
    await db.query("select status from public.tax_credits where id=$1", [
      lancado,
    ])
  ).rows[0];
  assert.equal(row.status, "cancelado");

  // Cancelar de novo recusa.
  await assert.rejects(cancel(lancado), /já está cancelado/i);

  // Crédito quitado não cancela.
  const quitado = await seedCredit("quitado", 1000);
  await assert.rejects(cancel(quitado), /quitado/i);
});

test("crédito com parcelamento ativo não cancela", async () => {
  const c = await seedCredit("divida_ativa");
  await db.query(
    `insert into public.tax_installment_plans
       (id, tenant_id, credit_id, numero_parcelas, valor_total, data_acordo, status)
     values ($1,$2,$3,3,1000,'2026-01-01','ativo')`,
    [randomUUID(), tenantId, c],
  );
  await assert.rejects(cancel(c), /parcelamento ativo/i);
});
