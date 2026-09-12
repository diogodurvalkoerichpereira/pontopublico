/**
 * O3-01 (Onda 3) — contratos administrativos (Lei 14.133): COMPORTAMENTO.
 *
 * saveContract cria/edita contrato; getContracts lê com saldo. Confere dedup por
 * número/ano, saldo (total - empenhado), e que o total não cai abaixo do empenhado.
 *
 * Mutação: remover o dedup (duplicata aceita) derruba.
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

const dir = mkdtempSync(join(tmpdir(), "contracts-test-"));

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
const base = (over = {}) => ({
  tenant_id: tenantId,
  numero: "001",
  ano: 2026,
  fornecedor: "Fornecedor LTDA",
  fornecedor_documento: "12.345.678/0001-90",
  objeto: "Material de expediente",
  modalidade: "pregao",
  valor_total: 200000,
  vigencia_inicio: "2026-01-01",
  vigencia_fim: "2026-12-31",
  status: "vigente",
  ...over,
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
  Object.assign(fn, await bundle("src/lib/contracts.functions.ts", "c.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("cria o contrato e lê com saldo", async () => {
  const { id } = await fn.saveContract({ data: base(), context: ctx() });
  const ws = await fn.getContracts({
    data: { tenant_id: tenantId, ano: 2026 },
    context: ctx(),
  });
  const row = ws.contracts.find((c) => c.id === id);
  assert.equal(Number(row.valor_total), 200000);
  assert.equal(Number(row.valor_empenhado), 0);
  assert.equal(Number(row.saldo), 200000);
  assert.equal(row.modalidade, "pregao");
});

test("dedup: mesmo número/ano é recusado", async () => {
  await assert.rejects(
    fn.saveContract({ data: base(), context: ctx() }),
    /Já existe contrato/,
  );
  const ok = await fn.saveContract({
    data: base({ numero: "002" }),
    context: ctx(),
  });
  assert.ok(ok.id);
});

test("valor do contrato não cai abaixo do já empenhado", async () => {
  const { id } = await fn.saveContract({
    data: base({ numero: "003" }),
    context: ctx(),
  });
  await db.query(
    "update public.procurement_contracts set valor_empenhado=150000 where id=$1",
    [id],
  );
  await assert.rejects(
    fn.saveContract({
      data: base({ id, numero: "003", valor_total: 100000 }),
      context: ctx(),
    }),
    /menor que o já empenhado/,
  );
});
