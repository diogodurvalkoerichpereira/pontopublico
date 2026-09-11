/**
 * O4-06 (Onda 4) — ITBI sobre transmissão: COMPORTAMENTO.
 *
 * launchItbi gera um crédito ITBI = valor da transmissão × alíquota, um por
 * transmissão (inscrição inclui a data). Confere o cálculo e a recusa de
 * lançamento duplicado na mesma transmissão.
 *
 * Mutação: usar o valor da transmissão sem a alíquota derruba.
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

const dir = mkdtempSync(join(tmpdir(), "itbi-test-"));

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

async function seedProperty(inscricao) {
  const id = randomUUID();
  await db.query(
    `insert into public.real_estate_properties
       (id, tenant_id, inscricao_imobiliaria, proprietario, proprietario_documento,
        endereco, valor_venal, status)
     values ($1,$2,$3,'Vendedor','000','Rua A, 1',200000,'ativo')`,
    [id, tenantId, inscricao],
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
  Object.assign(fn, await bundle("src/lib/itbi.functions.ts", "i.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const launch = (propertyId, valor, aliquota, data = "2026-03-15") =>
  fn.launchItbi({
    data: {
      tenant_id: tenantId,
      property_id: propertyId,
      adquirente: "Comprador",
      adquirente_documento: "12345678900",
      valor_transmissao: valor,
      aliquota,
      data_transmissao: data,
      vencimento: "2026-04-15",
    },
    context: ctx(),
  });

test("ITBI = valor da transmissão × alíquota; não duplica a transmissão", async () => {
  const p = await seedProperty("INS-T-1");
  const r = await launch(p, 300000, 2); // 2% de 300000 = 6000
  assert.equal(r.valor, 6000);
  const credit = (
    await db.query(
      `select tributo, valor_lancado::text, inscricao from public.tax_credits where id=$1`,
      [r.credit_id],
    )
  ).rows[0];
  assert.equal(credit.tributo, "ITBI");
  assert.equal(credit.valor_lancado, "6000.00");
  assert.equal(credit.inscricao, "INS-T-1/ITBI/2026-03-15");

  // Mesma transmissão (mesma data) não lança de novo.
  await assert.rejects(launch(p, 300000, 2), /já lançado/);

  // Outra transmissão (outra data) do mesmo imóvel é permitida.
  const r2 = await launch(p, 100000, 2, "2026-08-01");
  assert.equal(r2.valor, 2000);
});
