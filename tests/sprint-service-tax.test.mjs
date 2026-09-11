/**
 * O4-05 (Onda 4) — cadastro mobiliário + ISS: COMPORTAMENTO.
 *
 * saveServiceTaxpayer cadastra o prestador (dedup por inscrição); launchIss gera
 * um crédito ISS = base × alíquota por competência, um por competência. Confere o
 * cálculo, a inscrição "inscricao/competencia" e a recusa de lançamento duplicado.
 *
 * Mutação: usar a base sem multiplicar pela alíquota derruba o valor.
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

const dir = mkdtempSync(join(tmpdir(), "service-tax-test-"));

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

const cadastra = (inscricao, aliquota) =>
  fn.saveServiceTaxpayer({
    data: {
      tenant_id: tenantId,
      inscricao_municipal: inscricao,
      razao_social: "Prestadora LTDA",
      documento: "00011122000199",
      atividade: "Servicos de TI",
      aliquota_iss: aliquota,
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
  Object.assign(fn, await bundle("src/lib/service-tax.functions.ts", "st.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("lança ISS = base × alíquota por competência e grava crédito", async () => {
  const { id } = await cadastra("INS-M-1", 5); // 5%
  const r = await fn.launchIss({
    data: {
      tenant_id: tenantId,
      taxpayer_id: id,
      competencia: "2026-03",
      base_calculo: 10000, // 5% de 10000 = 500
      vencimento: "2026-04-10",
    },
    context: ctx(),
  });
  assert.equal(r.valor, 500);
  const credit = (
    await db.query(
      `select tributo, valor_lancado::text, inscricao from public.tax_credits where id=$1`,
      [r.credit_id],
    )
  ).rows[0];
  assert.equal(credit.tributo, "ISS");
  assert.equal(credit.valor_lancado, "500.00");
  assert.equal(credit.inscricao, "INS-M-1/2026-03");

  // Segunda competência do mesmo prestador é permitida (inscrição distinta).
  const r2 = await fn.launchIss({
    data: {
      tenant_id: tenantId,
      taxpayer_id: id,
      competencia: "2026-04",
      base_calculo: 20000,
      vencimento: "2026-05-10",
    },
    context: ctx(),
  });
  assert.equal(r2.valor, 1000);

  // Repetir a mesma competência é recusado.
  await assert.rejects(
    fn.launchIss({
      data: {
        tenant_id: tenantId,
        taxpayer_id: id,
        competencia: "2026-03",
        base_calculo: 5000,
        vencimento: "2026-04-10",
      },
      context: ctx(),
    }),
    /já lançado/,
  );
});

test("dedup por inscrição municipal e alíquota do cadastro", async () => {
  await cadastra("INS-M-2", 2);
  await assert.rejects(cadastra("INS-M-2", 3), /já cadastrada/);
  const tp = (
    await db.query(
      "select id from public.service_taxpayers where inscricao_municipal='INS-M-2'",
    )
  ).rows[0];
  // Sem alíquota no lançamento, usa 2% do cadastro: 2% de 100000 = 2000.
  const r = await fn.launchIss({
    data: {
      tenant_id: tenantId,
      taxpayer_id: tp.id,
      competencia: "2026-01",
      base_calculo: 100000,
      vencimento: "2026-02-10",
    },
    context: ctx(),
  });
  assert.equal(r.valor, 2000);
});
