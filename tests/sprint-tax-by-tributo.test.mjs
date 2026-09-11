/**
 * O4-01c (Onda 4 — Tributação) — arrecadação por tributo: COMPORTAMENTO.
 *
 * getTaxCreditsByTributo agrupa os créditos não cancelados por tipo de tributo, somando o
 * lançado e o arrecadado (pagamentos), ordenado do mais arrecadado ao menos. Crédito
 * cancelado não entra.
 *
 * Mutação: somar valor_lancado em vez de valor_pago no arrecadado, ou incluir cancelado,
 * derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "tax-by-tributo-test-"));

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
async function seedCredit({ tributo, lancado, pago = 0, status = "lancado" }) {
  seq += 1;
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,$3,2026,'C','00000000000',$4,$5,$6,'2026-03-10',$7)`,
    [randomUUID(), tenantId, tributo, `INS-${seq}`, lancado, pago, status],
  );
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
  Object.assign(fn, await bundle("src/lib/taxes.functions.ts", "tax.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("agrupa por tributo, ordena por arrecadado e ignora cancelado", async () => {
  // IPTU: lançado 1000, pago 800.
  await seedCredit({ tributo: "IPTU", lancado: 1000, pago: 800 });
  // ISS: lançado 500, pago 500.
  await seedCredit({ tributo: "ISS", lancado: 500, pago: 500 });
  // IPTU cancelado: não entra.
  await seedCredit({
    tributo: "IPTU",
    lancado: 9000,
    pago: 0,
    status: "cancelado",
  });

  const r = await fn.getTaxCreditsByTributo({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  // Ordenado por arrecadado desc: IPTU (800) antes de ISS (500).
  assert.deepEqual(
    r.tributos.map((t) => t.tributo),
    ["IPTU", "ISS"],
  );
  const iptu = r.tributos.find((t) => t.tributo === "IPTU");
  assert.equal(iptu.quantidade, 1); // o cancelado não conta
  assert.equal(iptu.lancado, 1000);
  assert.equal(iptu.arrecadado, 800);

  const iss = r.tributos.find((t) => t.tributo === "ISS");
  assert.equal(iss.arrecadado, 500);
});
