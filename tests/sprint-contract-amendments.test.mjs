/**
 * O3-07 (Onda 3) — termo aditivo de contrato (Lei 14.133, art. 125):
 * COMPORTAMENTO.
 *
 * registerContractAmendment adita valor (acréscimo/supressão, limite acumulado de
 * 25% do valor original) e/ou prazo. Confere o acúmulo do limite, a prorrogação e
 * que o limite de 25% é respeitado entre aditivos sucessivos.
 *
 * Mutação: comparar o acréscimo novo (e não o acumulado) ao limite derruba.
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

const dir = mkdtempSync(join(tmpdir(), "amendment-test-"));

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
  `const PERMS = ["contracts.read","contracts.manage"];
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

async function seedContract(valorTotal) {
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_contracts
       (id, tenant_id, numero, ano, fornecedor, fornecedor_documento, objeto,
        modalidade, valor_total, vigencia_inicio, vigencia_fim)
     values ($1,$2,$3,2026,'Fornecedor','000','Objeto','pregao',$4,
        '2026-01-01','2026-12-31')`,
    [id, tenantId, `CT-${id.slice(0, 8)}`, valorTotal],
  );
  return id;
}

const adita = (contractId, extra) =>
  fn.registerContractAmendment({
    data: {
      tenant_id: tenantId,
      contract_id: contractId,
      justificativa: "Necessidade superveniente de servico",
      data_aditivo: "2026-06-01",
      ...extra,
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
  Object.assign(
    fn,
    await bundle("src/lib/contract-amendments.functions.ts", "a.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("acréscimo dentro de 25% aplica; acúmulo que estoura é recusado", async () => {
  const c = await seedContract(1000);
  // +150 (15%) ok.
  const r1 = await adita(c, { tipo: "valor", valor_acrescimo: 150 });
  assert.equal(r1.numero, 1);
  assert.equal(r1.valor_total, 1150);
  // +100 acumula 250 (25% exato) ok.
  const r2 = await adita(c, { tipo: "valor", valor_acrescimo: 100 });
  assert.equal(r2.valor_total, 1250);
  // +1 estoura o acumulado (251 > 250).
  await assert.rejects(
    adita(c, { tipo: "valor", valor_acrescimo: 1 }),
    /limite de 25%/,
  );
  const row = (
    await db.query(
      "select valor_total::text from public.procurement_contracts where id=$1",
      [c],
    )
  ).rows[0];
  assert.equal(row.valor_total, "1250.00");
});

test("aditivo de prazo prorroga a vigência; retroceder é recusado", async () => {
  const c = await seedContract(500);
  const r = await adita(c, {
    tipo: "prazo",
    nova_vigencia_fim: "2027-06-30",
  });
  assert.equal(r.valor_total, 500); // prazo não mexe em valor
  const row = (
    await db.query(
      "select vigencia_fim::text from public.procurement_contracts where id=$1",
      [c],
    )
  ).rows[0];
  assert.equal(row.vigencia_fim, "2027-06-30");
  await assert.rejects(
    adita(c, { tipo: "prazo", nova_vigencia_fim: "2027-01-01" }),
    /posterior/,
  );
});
