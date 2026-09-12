/**
 * O2-20 (Onda 2) — cancelamento de restos a pagar (Lei 4.320 art. 38): COMPORTAMENTO.
 *
 * cancelRestoAPagar só cancela um resto INSCRITO; ao cancelar, o resto vai a 'cancelado'
 * e o empenho de origem a 'anulado' (obrigação extinta). Confere a extinção, a guarda de
 * estado e a recusa de cancelar um resto já pago/cancelado.
 *
 * Mutação: aceitar um resto não inscrito (inverter a guarda) derruba o teste.
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
let appropriationId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "restos-cancel-test-"));

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
  `const PERMS = ["budget.read","budget.manage"];
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

let numeroSeq = 0;
async function seedResto(status) {
  numeroSeq += 1;
  const commitmentId = randomUUID();
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho,
        tipo, credor, historico, valor, status)
     values ($1,$2,$3,2025,$4,'2025-02-01','ordinario','Fornecedor','Empenho',1000,'empenhado')`,
    [commitmentId, tenantId, appropriationId, numeroSeq],
  );
  const restoId = randomUUID();
  await db.query(
    `insert into public.restos_a_pagar
       (id, tenant_id, commitment_id, exercicio_origem, tipo, valor, inscrito_em, status)
     values ($1,$2,$3,2025,'nao_processado',1000,'2026-01-01',$4)`,
    [restoId, tenantId, commitmentId, status],
  );
  return { restoId, commitmentId };
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
  appropriationId = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado, valor_empenhado)
     values ($1,$2,2025,'01','04','122','0001','2001','3.3.90.30','01',50000,50000)`,
    [appropriationId, tenantId],
  );
  Object.assign(
    fn,
    await bundle("src/lib/restos-a-pagar.functions.ts", "rp.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const cancel = (restoId) =>
  fn.cancelRestoAPagar({
    data: {
      tenant_id: tenantId,
      resto_id: restoId,
      motivo: "Prescricao (art. 38)",
      data_cancelamento: "2026-12-31",
    },
    context: ctx(),
  });

test("cancela o resto inscrito e anula o empenho de origem", async () => {
  const { restoId, commitmentId } = await seedResto("inscrito");
  const r = await cancel(restoId);
  assert.equal(r.status, "cancelado");

  const resto = (
    await db.query("select status from public.restos_a_pagar where id=$1", [
      restoId,
    ])
  ).rows[0];
  assert.equal(resto.status, "cancelado");
  const commit = (
    await db.query("select status from public.budget_commitments where id=$1", [
      commitmentId,
    ])
  ).rows[0];
  assert.equal(commit.status, "anulado");
});

test("resto já pago não pode ser cancelado", async () => {
  const { restoId } = await seedResto("pago");
  await assert.rejects(cancel(restoId), /inscrito/i);
});
