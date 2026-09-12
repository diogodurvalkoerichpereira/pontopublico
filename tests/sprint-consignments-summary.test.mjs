/**
 * O1-09b (Onda 1 — Consignações) — resumo por tipo: COMPORTAMENTO.
 *
 * getConsignmentsSummary agrupa as consignações ATIVAS por tipo, somando as parcelas
 * mensais, com total geral. Consignação quitada/cancelada não entra (não compromete
 * margem).
 *
 * Mutação: incluir consignação não-ativa (remover o filtro status='ativa') derruba o
 * teste.
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
let linkId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "consignments-summary-test-"));

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
  `const PERMS = ["people.read","people.manage"];
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

async function seedConsignment({ tipo, valor, status = "ativa" }) {
  await db.query(
    `insert into public.payroll_consignments
       (id, tenant_id, employment_link_id, tipo, consignatario, valor_parcela,
        parcelas_total, inicio, status)
     values ($1,$2,$3,$4,'Banco X',$5,12,'2026-01-01',$6)`,
    [randomUUID(), tenantId, linkId, tipo, valor, status],
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
  const personId = (
    await db.query(
      `insert into public.persons (id, full_name)
       values ($1,'Servidor') returning id`,
      [randomUUID()],
    )
  ).rows[0].id;
  linkId = (
    await db.query(
      `insert into public.employment_links (id, tenant_id, person_id, registration_number, job_title, base_salary, status)
       values ($1,$2,$3,'M1','Cargo',5000,'rascunho') returning id`,
      [randomUUID(), tenantId, personId],
    )
  ).rows[0].id;
  Object.assign(
    fn,
    await bundle("src/lib/consignments.functions.ts", "cons.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("agrupa ativas por tipo; ignora quitada/cancelada", async () => {
  await seedConsignment({ tipo: "emprestimo", valor: 300 });
  await seedConsignment({ tipo: "emprestimo", valor: 200 });
  await seedConsignment({ tipo: "sindicato", valor: 50 });
  // Quitada e cancelada: fora do resumo.
  await seedConsignment({ tipo: "emprestimo", valor: 9999, status: "quitada" });
  await seedConsignment({ tipo: "pensao", valor: 8888, status: "cancelada" });

  const r = await fn.getConsignmentsSummary({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  const emp = r.tipos.find((t) => t.tipo === "emprestimo");
  assert.equal(emp.quantidade, 2);
  assert.equal(emp.total_parcela, 500);
  const sind = r.tipos.find((t) => t.tipo === "sindicato");
  assert.equal(sind.total_parcela, 50);
  // Ordenado por comprometido desc: emprestimo antes de sindicato.
  assert.equal(r.tipos[0].tipo, "emprestimo");

  assert.equal(r.totalConsignacoes, 3);
  assert.equal(r.totalParcela, 550);
});
