/**
 * O4-08 (Onda 4) — Certidão de Dívida Ativa (CDA, Lei 6.830): COMPORTAMENTO.
 *
 * emitActiveDebtCertificate numera a CDA por ente/exercício e fixa o saldo inscrito
 * (lançado − pago). Só um crédito em dívida ativa com saldo; uma CDA por crédito.
 * Confere a numeração sequencial, o valor inscrito (saldo, não o lançado), a guarda
 * de estado e a unicidade por crédito.
 *
 * Mutação: usar o valor lançado em vez do saldo no valor_inscrito derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "cda-test-"));

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
async function seedCredit(lancado, pago, status) {
  inscSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',2026,'Contribuinte','00000000000',$3,$4,$5,'2026-01-01',$6)`,
    [id, tenantId, `INSC-${inscSeq}`, lancado, pago, status],
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

const emit = (credit) =>
  fn.emitActiveDebtCertificate({
    data: {
      tenant_id: tenantId,
      credit_id: credit,
      data_inscricao: "2026-04-01",
    },
    context: ctx(),
  });

test("CDA numera e fixa o saldo inscrito (não o valor lançado)", async () => {
  const c = await seedCredit(1000, 200, "divida_ativa"); // saldo 800
  const r = await emit(c);
  assert.equal(r.numero, 1);
  assert.equal(r.valor_inscrito, 800);

  // Numeração sequencial por exercício.
  const c2 = await seedCredit(500, 0, "divida_ativa");
  const r2 = await emit(c2);
  assert.equal(r2.numero, 2);

  // Uma CDA por crédito.
  await assert.rejects(emit(c), /já possui CDA/i);
});

test("só um crédito em dívida ativa recebe CDA", async () => {
  const lancado = await seedCredit(300, 0, "lancado");
  await assert.rejects(emit(lancado), /dívida ativa/i);
});
