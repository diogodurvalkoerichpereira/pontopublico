/**
 * O3-08e (Onda 5) — desclassificação de proposta no julgamento (Lei 14.133 art. 59):
 * COMPORTAMENTO.
 *
 * disqualifyProcurementProposal marca uma proposta como desclassificada (com motivo) numa
 * licitação aberta; ela deixa de concorrer, então a menor entre as classificadas passa a ser
 * outra. Só em licitação aberta; já desclassificada não desclassifica de novo.
 *
 * Mutação: não gravar desclassificada (update no-op) deixa a proposta ainda vencer — derruba.
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

const dir = mkdtempSync(join(tmpdir(), "procurement-disqualify-test-"));

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
async function seedProcess(status) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_processes
       (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado, status, abertura)
     values ($1,$2,$3,2026,'pregao','Objeto',100000,$4,'2026-01-01')`,
    [id, tenantId, `PL-${seq}`, status],
  );
  return id;
}
const propose = (processId, fornecedor, doc, valor) =>
  fn.recordProcurementProposal({
    data: {
      tenant_id: tenantId,
      process_id: processId,
      fornecedor,
      fornecedor_documento: doc,
      valor_proposto: valor,
    },
    context: ctx(),
  });
const disqualify = (processId, proposalId) =>
  fn.disqualifyProcurementProposal({
    data: {
      tenant_id: tenantId,
      process_id: processId,
      proposal_id: proposalId,
      motivo: "Proposta inexequivel (art. 59)",
    },
    context: ctx(),
  });
const judgment = (processId) =>
  fn.getProcurementJudgment({
    data: { tenant_id: tenantId, process_id: processId },
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
    await bundle("src/lib/procurement.functions.ts", "proc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("desclassificar a menor faz a próxima classificada vencer; só em aberta; não repete", async () => {
  const proc = await seedProcess("aberta");
  await propose(proc, "Alfa", "111", 500);
  await propose(proc, "Beta", "222", 300);
  const gama = await propose(proc, "Gama", "333", 100); // menor → venceria

  const antes = await judgment(proc);
  assert.equal(antes.vencedor.fornecedor, "Gama");

  // Desclassifica Gama → Beta (300) passa a vencer.
  const d = await disqualify(proc, gama.id);
  assert.equal(d.desclassificada, true);
  const depois = await judgment(proc);
  assert.equal(depois.vencedor.fornecedor, "Beta");

  // Já desclassificada não desclassifica de novo.
  await assert.rejects(disqualify(proc, gama.id), /já desclassificada/i);

  // Licitação não-aberta não desclassifica (proposta entra com a licitação aberta,
  // depois a licitação é homologada).
  const homolog = await seedProcess("aberta");
  const p = await propose(homolog, "Delta", "444", 200);
  await db.query(
    "update public.procurement_processes set status='homologada' where id=$1",
    [homolog],
  );
  await assert.rejects(disqualify(homolog, p.id), /aberta/i);
});
