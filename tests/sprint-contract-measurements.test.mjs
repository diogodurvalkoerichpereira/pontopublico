/**
 * O3-14 (Onda 3) — medição / recebimento de contrato (Lei 14.133 art. 140): COMPORTAMENTO.
 *
 * recordContractMeasurement acumula o valor executado do contrato vigente, numerando por
 * contrato; a execução acumulada nunca passa do valor EMPENHADO (só se liquida o que foi
 * empenhado). Confere a acumulação, a numeração, o teto e a guarda de estado.
 *
 * Mutação: usar o valor total em vez do empenhado no teto derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "contract-meas-test-"));

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
async function seedContract(status, empenhado) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_contracts
       (id, tenant_id, numero, ano, fornecedor, fornecedor_documento, objeto,
        modalidade, valor_total, valor_empenhado, vigencia_inicio, vigencia_fim, status)
     values ($1,$2,$3,2026,'Fornecedor','00000000000','Obra','pregao',10000,$4,
        '2026-01-01','2026-12-31',$5)`,
    [id, tenantId, `CT-${seq}`, empenhado, status],
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
    await bundle("src/lib/contract-measurements.functions.ts", "cm.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const measure = (contract, valor) =>
  fn.recordContractMeasurement({
    data: {
      tenant_id: tenantId,
      contract_id: contract,
      competencia: "2026-05",
      valor,
      descricao: "Medicao mensal",
      data_medicao: "2026-05-31",
    },
    context: ctx(),
  });

test("acumula o executado e numera; nunca passa do empenhado", async () => {
  // Contrato de 10000, empenhado 5000.
  const c = await seedContract("vigente", 5000);

  const r1 = await measure(c, 3000);
  assert.equal(r1.numero, 1);
  assert.equal(r1.valor_executado, 3000);

  // 3000 + 3000 = 6000 > 5000 empenhado: recusa.
  await assert.rejects(measure(c, 3000), /empenhado/i);

  // 3000 + 2000 = 5000 (limite do empenhado): aceita, numera 2.
  const r2 = await measure(c, 2000);
  assert.equal(r2.numero, 2);
  assert.equal(r2.valor_executado, 5000);

  const contract = (
    await db.query(
      "select valor_executado::text from public.procurement_contracts where id=$1",
      [c],
    )
  ).rows[0];
  assert.equal(contract.valor_executado, "5000.00");
});

test("contrato não vigente não é medido", async () => {
  const suspenso = await seedContract("suspenso", 5000);
  await assert.rejects(measure(suspenso, 100), /vigente/i);
});
