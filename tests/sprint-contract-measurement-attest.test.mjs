/**
 * O3-14b (Onda 3) — Recebimento definitivo da medição (Lei 14.133 art. 140): COMPORTAMENTO.
 *
 * attestContractMeasurement move uma medição PROVISÓRIA para 'definitivo' (o atesto que
 * autoriza o pagamento). Uma medição já definitiva não reabre e não pode ser atestada de
 * novo; medição inexistente é recusada.
 *
 * Mutação: remover a guarda de estado (recebimento === 'definitivo') deixa atestar duas
 * vezes — o teste derruba.
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

const dir = mkdtempSync(join(tmpdir(), "cm-attest-test-"));

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
async function seedContract() {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_contracts
       (id, tenant_id, numero, ano, fornecedor, fornecedor_documento, objeto,
        modalidade, valor_total, valor_empenhado, vigencia_inicio, vigencia_fim, status)
     values ($1,$2,$3,2026,'Fornecedor','00000000000','Obra','pregao',10000,10000,
        '2026-01-01','2026-12-31','vigente')`,
    [id, tenantId, `CTA-${seq}`],
  );
  return id;
}

const measure = (contract) =>
  fn.recordContractMeasurement({
    data: {
      tenant_id: tenantId,
      contract_id: contract,
      competencia: "2026-05",
      valor: 1000,
      descricao: "Medicao mensal",
      data_medicao: "2026-05-31",
    },
    context: ctx(),
  });

const attest = (measurementId) =>
  fn.attestContractMeasurement({
    data: { tenant_id: tenantId, measurement_id: measurementId },
    context: ctx(),
  });

const recebimentoOf = async (id) =>
  (
    await db.query(
      "select recebimento from public.contract_measurements where id=$1",
      [id],
    )
  ).rows[0].recebimento;

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
    await bundle("src/lib/contract-measurements.functions.ts", "cma.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("provisória → definitiva; definitiva não reabre; inexistente recusada", async () => {
  const c = await seedContract();
  const m = await measure(c);
  assert.equal(await recebimentoOf(m.id), "provisorio");

  const r = await attest(m.id);
  assert.equal(r.recebimento, "definitivo");
  assert.equal(await recebimentoOf(m.id), "definitivo");

  // Já definitiva: não pode atestar de novo.
  await assert.rejects(attest(m.id), /já recebida em definitivo/i);

  // Medição inexistente.
  await assert.rejects(attest(randomUUID()), /não encontrada/i);
});
