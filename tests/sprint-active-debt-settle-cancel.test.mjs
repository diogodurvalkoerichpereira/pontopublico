/**
 * O4-08b/c (Onda 5) — baixa da CDA por quitação e cancelamento: COMPORTAMENTO.
 *
 * settleActiveDebtCertificate baixa (quitada) uma CDA ativa SÓ quando o crédito de origem
 * está integralmente pago (saldo ≤ 0), tirando-a do estoque em cobrança;
 * cancelActiveDebtCertificate cancela uma CDA ativa (prescrição/erro). Ambas ativam status
 * que existiam no enum mas nada gravava. Uma CDA não-ativa não transita de novo.
 *
 * Mutação: permitir quitar com saldo devedor (remover a guarda saldo ≤ 0) derruba.
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

const dir = mkdtempSync(join(tmpdir(), "cda-settle-test-"));

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
async function seedCredit(lancado, pago) {
  inscSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',2026,'Contribuinte','00000000000',$3,$4,$5,'2026-01-01','divida_ativa')`,
    [id, tenantId, `INSC-${inscSeq}`, lancado, pago],
  );
  return id;
}
const emit = (credit) =>
  fn.emitActiveDebtCertificate({
    data: {
      tenant_id: tenantId,
      credit_id: credit,
      data_inscricao: "2026-04-01",
    },
    context: ctx(),
  });
const settle = (id) =>
  fn.settleActiveDebtCertificate({
    data: { tenant_id: tenantId, certificate_id: id },
    context: ctx(),
  });
const cancel = (id) =>
  fn.cancelActiveDebtCertificate({
    data: { tenant_id: tenantId, certificate_id: id, motivo: "Prescricao" },
    context: ctx(),
  });
const statusOf = async (id) =>
  (
    await db.query(
      "select status from public.active_debt_certificates where id=$1",
      [id],
    )
  ).rows[0].status;

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

test("quitação só com crédito integralmente pago; cancelamento sempre; não-ativa recusa", async () => {
  // Crédito com saldo (1000 lançado, 400 pago): CDA não pode ser quitada.
  const comSaldo = await seedCredit(1000, 400);
  const cda1 = await emit(comSaldo);
  await assert.rejects(settle(cda1.id), /integralmente pago/i);
  assert.equal(await statusOf(cda1.id), "ativa");

  // Paga o restante do crédito → CDA pode ser quitada.
  await db.query(
    "update public.tax_credits set valor_pago=1000, status='quitado' where id=$1",
    [comSaldo],
  );
  const r = await settle(cda1.id);
  assert.equal(r.status, "quitada");
  assert.equal(await statusOf(cda1.id), "quitada");

  // CDA já quitada não é quitada nem cancelada de novo.
  await assert.rejects(settle(cda1.id), /ativa/i);
  await assert.rejects(cancel(cda1.id), /ativa/i);

  // Outra CDA: cancelamento (prescrição) leva a 'cancelada'.
  const outro = await seedCredit(500, 0);
  const cda2 = await emit(outro);
  const c = await cancel(cda2.id);
  assert.equal(c.status, "cancelada");
  assert.equal(await statusOf(cda2.id), "cancelada");
});
