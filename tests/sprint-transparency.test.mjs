/**
 * O5-02 (Onda 5) — portal da transparência: COMPORTAMENTO (agregação).
 *
 * getTransparencyReport consolida despesa (execução), receita e contratos do
 * exercício. Confere os totais e que empenho anulado não entra no empenhado.
 *
 * Mutação: contar empenho anulado no empenhado derruba.
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

const dir = mkdtempSync(join(tmpdir(), "transp-test-"));

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
  `const PERMS = ["transparency.read"];
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

  // Despesa: dotacao 100000 + empenhos (pago 30000, empenhado 20000, anulado 99999).
  const dot = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id,tenant_id,exercicio,unidade_orcamentaria,funcao,subfuncao,programa,acao,natureza_despesa,fonte_recurso,valor_orcado,valor_empenhado)
     values ($1,$2,2026,'02.01','04','122','0001','2001','3.1.90.11.00','1.500.0000',100000,50000)`,
    [dot, tenantId],
  );
  const ins = async (numero, valor, status) =>
    db.query(
      `insert into public.budget_commitments
         (id,tenant_id,appropriation_id,exercicio,numero,data_empenho,tipo,credor,historico,valor,status)
       values ($1,$2,$3,2026,$4,'2026-03-01','ordinario','X','h',$5,$6)`,
      [randomUUID(), tenantId, dot, numero, valor, status],
    );
  await ins(1, 30000, "pago");
  await ins(2, 20000, "empenhado");
  await ins(3, 99999, "anulado");

  // Receita: previsto 80000, arrecadado 50000.
  await db.query(
    `insert into public.budget_revenues
       (id,tenant_id,exercicio,natureza_receita,fonte_recurso,descricao,valor_previsto,valor_arrecadado)
     values ($1,$2,2026,'1.1.1.2.01','1.500.0000','ISS',80000,50000)`,
    [randomUUID(), tenantId],
  );

  // Contrato vigente 200000.
  await db.query(
    `insert into public.procurement_contracts
       (id,tenant_id,numero,ano,fornecedor,fornecedor_documento,objeto,modalidade,valor_total,vigencia_inicio,vigencia_fim,status)
     values ($1,$2,'001',2026,'Forn','12.345.678/0001-90','Obj','pregao',200000,'2026-01-01','2026-12-31','vigente')`,
    [randomUUID(), tenantId],
  );

  Object.assign(fn, await bundle("src/lib/transparency.functions.ts", "t.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("o relatório consolida despesa, receita e contratos", async () => {
  const r = await fn.getTransparencyReport({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  assert.equal(r.despesa.orcado, 100000);
  assert.equal(r.despesa.empenhado, 50000, "anulado (99999) fora");
  assert.equal(r.despesa.liquidado, 30000);
  assert.equal(r.despesa.pago, 30000);
  assert.equal(r.despesa.saldo, 50000);
  assert.equal(r.receita.previsto, 80000);
  assert.equal(r.receita.arrecadado, 50000);
  assert.equal(r.receita.a_realizar, 30000);
  assert.equal(r.contratos.quantidade, 1);
  assert.equal(r.contratos.valor_total, 200000);
  assert.equal(r.resultado_orcamentario, 20000);
});
