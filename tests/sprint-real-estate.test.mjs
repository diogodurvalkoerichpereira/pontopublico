/**
 * O4-04 (Onda 4) — cadastro imobiliário + IPTU: COMPORTAMENTO.
 *
 * savePropertyRegistration cadastra o imóvel (dedup por inscrição); launchIptu
 * gera um crédito tributário IPTU = valor venal × alíquota, um por imóvel/exercício.
 * Confere o cálculo, a gravação em tax_credits e a recusa de lançamento duplicado.
 *
 * Mutação: dividir a alíquota por 10 em vez de 100 no cálculo derruba o valor.
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

const dir = mkdtempSync(join(tmpdir(), "real-estate-test-"));

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

const cadastra = (inscricao, valorVenal) =>
  fn.savePropertyRegistration({
    data: {
      tenant_id: tenantId,
      inscricao_imobiliaria: inscricao,
      proprietario: "Fulano",
      proprietario_documento: "00011122233",
      endereco: "Rua A, 100",
      valor_venal: valorVenal,
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
  Object.assign(fn, await bundle("src/lib/real-estate.functions.ts", "re.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("lança IPTU = valor venal × alíquota e grava crédito", async () => {
  const { id } = await cadastra("INS-100", 200000);
  const r = await fn.launchIptu({
    data: {
      tenant_id: tenantId,
      property_id: id,
      exercicio: 2026,
      aliquota: 1, // 1% de 200000 = 2000
      vencimento: "2026-03-10",
    },
    context: ctx(),
  });
  assert.equal(r.valor, 2000);
  const credit = (
    await db.query(
      `select tributo, valor_lancado::text, inscricao, status
       from public.tax_credits where id=$1`,
      [r.credit_id],
    )
  ).rows[0];
  assert.equal(credit.tributo, "IPTU");
  assert.equal(credit.valor_lancado, "2000.00");
  assert.equal(credit.inscricao, "INS-100");
  assert.equal(credit.status, "lancado");

  // Segundo lançamento no mesmo exercício é recusado.
  await assert.rejects(
    fn.launchIptu({
      data: {
        tenant_id: tenantId,
        property_id: id,
        exercicio: 2026,
        aliquota: 1,
        vencimento: "2026-03-10",
      },
      context: ctx(),
    }),
    /já lançado/,
  );
});

test("dedup por inscrição imobiliária no cadastro", async () => {
  await cadastra("INS-200", 100000);
  await assert.rejects(cadastra("INS-200", 150000), /já cadastrada/);
});

test("alíquota fracionada calcula e arredonda", async () => {
  const { id } = await cadastra("INS-300", 123456);
  const r = await fn.launchIptu({
    data: {
      tenant_id: tenantId,
      property_id: id,
      exercicio: 2026,
      aliquota: 1.3, // 1.3% de 123456 = 1604.928 → 1604.93
      vencimento: "2026-03-10",
    },
    context: ctx(),
  });
  assert.equal(r.valor, 1604.93);
});
