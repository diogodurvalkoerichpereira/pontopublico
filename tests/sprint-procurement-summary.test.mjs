/**
 * O3-06b (Onda 3 — Contratações) — resumo das licitações: COMPORTAMENTO.
 *
 * getProcurementSummary conta as licitações por desfecho, soma o valor estimado total e o
 * valor homologado APENAS das homologadas.
 *
 * Mutação: somar o valor homologado de licitações não homologadas (remover o filter)
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

const dir = mkdtempSync(join(tmpdir(), "procurement-summary-test-"));

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

let seq = 0;
async function seedProcess({ status, estimado, homologado = null }) {
  seq += 1;
  await db.query(
    `insert into public.procurement_processes
       (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado, status,
        abertura, valor_homologado)
     values ($1,$2,$3,2026,'pregao','Objeto',$4,$5,'2026-01-01',$6)`,
    [randomUUID(), tenantId, `PL-${seq}`, estimado, status, homologado],
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
  Object.assign(
    fn,
    await bundle("src/lib/procurement.functions.ts", "proc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("conta por desfecho; valor homologado só das homologadas", async () => {
  await seedProcess({ status: "homologada", estimado: 1000, homologado: 900 });
  await seedProcess({ status: "aberta", estimado: 500 });
  await seedProcess({ status: "fracassada", estimado: 300 });
  // Revogada que carrega um valor_homologado residual (adjudicada antes de revogar):
  // NÃO pode entrar no valor homologado (filtro por status='homologada').
  await seedProcess({ status: "revogada", estimado: 200, homologado: 150 });

  const r = await fn.getProcurementSummary({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  assert.equal(r.porStatus.homologada, 1);
  assert.equal(r.porStatus.aberta, 1);
  assert.equal(r.porStatus.fracassada, 1);
  assert.equal(r.porStatus.revogada, 1);
  assert.equal(r.total, 4);
  assert.equal(r.valorEstimado, 2000);
  // Só a homologada contribui ao valor homologado (não a revogada com resíduo).
  assert.equal(r.valorHomologado, 900);
});
