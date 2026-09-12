/**
 * O3-08c (Onda 3 — Contratações) — adjudicação do vencedor (Lei 14.133 art. 71):
 * COMPORTAMENTO.
 *
 * adjudicateProcurementWinner fixa, numa licitação homologada, a proposta de menor valor
 * entre as classificadas e o valor homologado. Exige licitação homologada e ao menos uma
 * proposta classificada; a desclassificada mais barata não é adjudicada.
 *
 * Mutação: adjudicar a proposta desclassificada (ignorar o filtro), ou permitir adjudicar
 * uma licitação ainda aberta, derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "procurement-award-test-"));

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
async function seedProposal(
  processId,
  fornecedor,
  doc,
  valor,
  desclass = false,
) {
  await db.query(
    `insert into public.procurement_proposals
       (id, tenant_id, process_id, fornecedor, fornecedor_documento,
        valor_proposto, desclassificada, motivo_desclassificacao)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      tenantId,
      processId,
      fornecedor,
      doc,
      valor,
      desclass,
      desclass ? "Documento vencido" : null,
    ],
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

const adjudicate = (processId) =>
  fn.adjudicateProcurementWinner({
    data: { tenant_id: tenantId, process_id: processId },
    context: ctx(),
  });

test("adjudica a menor válida numa licitação homologada", async () => {
  const proc = await seedProcess("homologada");
  await seedProposal(proc, "Alfa", "111", 500);
  await seedProposal(proc, "Beta", "222", 300);
  await seedProposal(proc, "Gama", "333", 100, true); // desclassificada, mais barata

  const r = await adjudicate(proc);
  assert.equal(r.valor_homologado, 300); // Beta, não a desclassificada Gama

  // Refletido na leitura consolidada.
  const list = await fn.getProcurementProcesses({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  const row = list.processes.find((p) => p.id === proc);
  assert.equal(row.vencedor, "Beta");
  assert.equal(row.valor_homologado, "300.00");
});

test("licitação aberta não adjudica; homologada sem proposta válida recusa", async () => {
  const aberta = await seedProcess("aberta");
  await seedProposal(aberta, "Alfa", "111", 200);
  await assert.rejects(adjudicate(aberta), /homologada/i);

  const semValida = await seedProcess("homologada");
  await seedProposal(semValida, "Alfa", "111", 200, true); // só desclassificada
  await assert.rejects(adjudicate(semValida), /classificada/i);
});
