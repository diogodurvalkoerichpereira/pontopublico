/**
 * O3-14d (Onda 5) — execução físico-financeira do contrato: COMPORTAMENTO.
 *
 * getContractMeasurementsSummary consolida, por contrato, contratado/empenhado/executado e o
 * saldo executável, e reparte as medições por situação: definitivo (atestado, autoriza
 * pagamento), provisório (aguardando atesto) e glosado (cancelado, devolveu o saldo).
 *
 * Mutação: trocar o filtro 'definitivo' por 'provisorio' no total definitivo derruba.
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

const dir = mkdtempSync(join(tmpdir(), "cm-summary-test-"));

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
async function seedContract(empenhado) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_contracts
       (id, tenant_id, numero, ano, fornecedor, fornecedor_documento, objeto,
        modalidade, valor_total, valor_empenhado, vigencia_inicio, vigencia_fim, status)
     values ($1,$2,$3,2026,'Fornecedor','00000000000','Obra','pregao',10000,$4,
        '2026-01-01','2026-12-31','vigente')`,
    [id, tenantId, `CT-${seq}`, empenhado],
  );
  return id;
}
async function measure(contract, valor, recebimento = "provisorio") {
  return fn.recordContractMeasurement({
    data: {
      tenant_id: tenantId,
      contract_id: contract,
      competencia: "2026-05",
      valor,
      descricao: "Medicao mensal",
      data_medicao: "2026-05-31",
      recebimento,
    },
    context: ctx(),
  });
}
const summary = (contract) =>
  fn.getContractMeasurementsSummary({
    data: { tenant_id: tenantId, contract_id: contract },
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
    await bundle("src/lib/contract-measurements.functions.ts", "cm.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("reparte medições em definitivo/provisório/glosado e apura o saldo executável", async () => {
  const c = await seedContract(8000); // contratado 10000, empenhado 8000
  // Definitivo (atestado): 3000.
  const m1 = await measure(c, 3000, "definitivo");
  // Provisório (aguardando atesto): 2000.
  await measure(c, 2000);
  // Provisório que será glosado: 1000.
  const m3 = await measure(c, 1000);
  await fn.cancelContractMeasurement({
    data: { tenant_id: tenantId, measurement_id: m3.id, motivo: "Divergencia" },
    context: ctx(),
  });

  const r = await summary(c);
  // Executado = 3000 + 2000 = 5000 (a glosa de 1000 devolveu o saldo).
  assert.equal(r.valor_total, 10000);
  assert.equal(r.valor_empenhado, 8000);
  assert.equal(r.valor_executado, 5000);
  assert.equal(r.saldo_a_executar, 5000);
  assert.equal(r.medicoes.definitivo, 3000);
  assert.equal(r.medicoes.provisorio, 2000);
  assert.equal(r.medicoes.glosado, 1000);
  assert.equal(r.medicoes.q_definitivo, 1);
  assert.equal(r.medicoes.q_provisorio, 1);
  assert.equal(r.medicoes.q_glosado, 1);
  assert.ok(m1.numero >= 1);
});
