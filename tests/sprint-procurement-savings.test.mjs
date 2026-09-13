/**
 * O3-08d (Onda 5) — economia da licitação (Lei 14.133, eficiência): COMPORTAMENTO.
 *
 * getProcurementSavings lista os certames já adjudicados (valor homologado definido) com a
 * economia = valor estimado − valor homologado e o percentual sobre o estimado, e consolida
 * estimado/homologado/economia totais. Certame sem valor homologado (não adjudicado) não
 * entra; o filtro por ano recorta o conjunto.
 *
 * Mutação: somar homologado − estimado (sinal invertido) na economia derruba os totais.
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

const dir = mkdtempSync(join(tmpdir(), "procurement-savings-test-"));

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
// homologado nulo => não adjudicado.
async function seedProcess(ano, estimado, homologado) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_processes
       (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado, valor_homologado,
        status, abertura, homologado_em)
     values ($1,$2,$3,$4,'pregao','Objeto',$5,$6::numeric,'homologada','${ano}-01-01',
        case when $6::numeric is null then null else '${ano}-02-01'::date end)`,
    [id, tenantId, `PL-${seq}`, ano, estimado, homologado],
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
    await bundle("src/lib/procurement.functions.ts", "proc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const savings = (ano) =>
  fn.getProcurementSavings({
    data: { tenant_id: tenantId, ...(ano ? { ano } : {}) },
    context: ctx(),
  });

test("consolida a economia dos adjudicados; não adjudicado e outro ano ficam de fora", async () => {
  await seedProcess(2026, 100000, 80000); // economia 20000 (20%)
  await seedProcess(2026, 200000, 150000); // economia 50000 (25%)
  await seedProcess(2026, 300000, null); // não adjudicado: fora
  await seedProcess(2025, 500000, 400000); // outro ano: fora do recorte 2026

  const r = await savings(2026);
  assert.equal(r.processos.length, 2);
  assert.deepEqual(
    r.processos.map((p) => [p.economia, p.percentual]),
    [
      [20000, 20],
      [50000, 25],
    ],
  );
  assert.equal(r.totais.estimado, 300000);
  assert.equal(r.totais.homologado, 230000);
  assert.equal(r.totais.economia, 70000);
  assert.equal(r.totais.percentual, 23.33);

  // Sem recorte de ano, o de 2025 também entra (3 no total).
  const todos = await savings();
  assert.equal(todos.processos.length, 3);
  assert.equal(todos.totais.economia, 170000);
});
