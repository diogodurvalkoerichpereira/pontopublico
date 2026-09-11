/**
 * O3-09 (Onda 3) — vínculo contrato↔licitação (Lei 14.133): COMPORTAMENTO.
 *
 * linkContractToProcurement liga o contrato à licitação de origem; só uma
 * licitação homologada, do mesmo ente e mesma modalidade, pode originar contrato.
 * Confere o vínculo, a recusa de licitação não homologada e a de modalidade
 * divergente.
 *
 * Mutação: aceitar licitação não homologada derruba.
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

const dir = mkdtempSync(join(tmpdir(), "contract-proc-test-"));

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

async function seedContract(modalidade) {
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_contracts
       (id, tenant_id, numero, ano, fornecedor, fornecedor_documento, objeto,
        modalidade, valor_total, vigencia_inicio, vigencia_fim)
     values ($1,$2,$3,2026,'Fornecedor','000','Objeto',$4,1000,
        '2026-01-01','2026-12-31')`,
    [id, tenantId, `CT-${id.slice(0, 8)}`, modalidade],
  );
  return id;
}

async function seedProcess(modalidade, status) {
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_processes
       (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado, status, abertura)
     values ($1,$2,$3,2026,$4,'Objeto',1000,$5,'2026-01-01')`,
    [id, tenantId, `PE-${id.slice(0, 8)}`, modalidade, status],
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
    await bundle("src/lib/contract-procurement.functions.ts", "l.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const link = (contractId, processId) =>
  fn.linkContractToProcurement({
    data: {
      tenant_id: tenantId,
      contract_id: contractId,
      process_id: processId,
    },
    context: ctx(),
  });

test("liga contrato a licitação homologada de mesma modalidade", async () => {
  const contract = await seedContract("pregao");
  const process = await seedProcess("pregao", "homologada");
  const r = await link(contract, process);
  assert.equal(r.procurement_process_id, process);
  const row = (
    await db.query(
      "select procurement_process_id from public.procurement_contracts where id=$1",
      [contract],
    )
  ).rows[0];
  assert.equal(row.procurement_process_id, process);
});

test("recusa licitação não homologada e modalidade divergente", async () => {
  const contract = await seedContract("pregao");
  const aberta = await seedProcess("pregao", "aberta");
  await assert.rejects(link(contract, aberta), /homologada/);

  const outraModalidade = await seedProcess("concorrencia", "homologada");
  await assert.rejects(link(contract, outraModalidade), /modalidade/);
});
