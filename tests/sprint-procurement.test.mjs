/**
 * O3-06 (Onda 3) — licitação (Lei 14.133): COMPORTAMENTO (ponta a ponta).
 *
 * openProcurementProcess abre o certame; transitionProcurementProcess encerra
 * (homologada/fracassada/...). Confere a dedup por número/ano, a homologação e que
 * uma licitação já encerrada não transita de novo.
 *
 * Mutação: permitir transitar uma licitação não-aberta derruba.
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

const dir = mkdtempSync(join(tmpdir(), "procurement-test-"));

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
const open = (numero) =>
  fn.openProcurementProcess({
    data: {
      tenant_id: tenantId,
      numero,
      ano: 2026,
      modalidade: "pregao",
      objeto: "Aquisicao de material",
      valor_estimado: 500000,
      abertura: "2026-02-01",
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
  Object.assign(fn, await bundle("src/lib/procurement.functions.ts", "p.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("abre, dedup por número/ano, homologa", async () => {
  const p = await open("PE-001");
  await assert.rejects(open("PE-001"), /Já existe licitação/);

  const r = await fn.transitionProcurementProcess({
    data: {
      tenant_id: tenantId,
      process_id: p.id,
      desfecho: "homologada",
      data_referencia: "2026-03-01",
    },
    context: ctx(),
  });
  assert.equal(r.status, "homologada");
  const row = (
    await db.query(
      "select status, homologado_em::text from public.procurement_processes where id=$1",
      [p.id],
    )
  ).rows[0];
  assert.equal(row.status, "homologada");
  assert.equal(row.homologado_em, "2026-03-01");
});

test("licitação já encerrada não transita de novo", async () => {
  const p = await open("PE-002");
  await fn.transitionProcurementProcess({
    data: {
      tenant_id: tenantId,
      process_id: p.id,
      desfecho: "revogada",
      data_referencia: "2026-03-01",
    },
    context: ctx(),
  });
  await assert.rejects(
    fn.transitionProcurementProcess({
      data: {
        tenant_id: tenantId,
        process_id: p.id,
        desfecho: "homologada",
        data_referencia: "2026-04-01",
      },
      context: ctx(),
    }),
    /aberta/,
  );
});
