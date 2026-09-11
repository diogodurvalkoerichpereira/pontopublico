/**
 * O2-25 (Onda 2) — balanço financeiro (Lei 4.320 Anexo 13): COMPORTAMENTO.
 *
 * getFinancialBalance confronta ingressos (receita orçamentária arrecadada + restos
 * inscritos no ano) com dispêndios (despesa orçamentária paga + restos pagos no ano) e
 * apura o resultado financeiro. Restos são datados por inscrito_em/pago_em. Confere os
 * componentes, os totais e o resultado.
 *
 * Mutação: somar em vez de subtrair no resultado financeiro derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "financial-balance-test-"));

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

function stubPlugin() {
  return {
    name: "stub",
    setup(b) {
      const map = [
        [/@tanstack\/react-start$/, startStub],
        [/(^|\/)db\.server$/, dbStub],
        [/(^|\/)data\.functions$/, dataStub],
        [/(^|\/)tenant-access\.server$/, taStub],
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
async function seedCommitment(valor, status) {
  numeroSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho,
        tipo, credor, historico, valor, status)
     values ($1,$2,$3,2026,$4,'2026-02-01','ordinario','F','E',$5,$6)`,
    [id, tenantId, appropriationId, numeroSeq, valor, status],
  );
  return id;
}

async function seedResto(
  commitmentId,
  valor,
  tipo,
  inscritoEm,
  status,
  pagoEm,
) {
  await db.query(
    `insert into public.restos_a_pagar
       (id, tenant_id, commitment_id, exercicio_origem, tipo, valor, inscrito_em, status, pago_em)
     values ($1,$2,$3,2025,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      tenantId,
      commitmentId,
      tipo,
      valor,
      inscritoEm,
      status,
      pagoEm,
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
  appropriationId = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado, valor_empenhado)
     values ($1,$2,2026,'01','04','122','0001','2001','3.3.90.30','01',50000,0)`,
    [appropriationId, tenantId],
  );
  Object.assign(
    fn,
    await bundle("src/lib/financial-balance.functions.ts", "fb.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("confronta ingressos e dispêndios (orçamentários + extraorçamentários)", async () => {
  // Receita orçamentária arrecadada: 9000.
  await db.query(
    `insert into public.budget_revenues
       (id, tenant_id, exercicio, natureza_receita, fonte_recurso, descricao,
        valor_previsto, valor_arrecadado)
     values ($1,$2,2026,'1.1.1','01','R',10000,9000)`,
    [randomUUID(), tenantId],
  );
  // Despesa orçamentária paga: 2000 (um pago, um empenhado que não conta).
  await seedCommitment(2000, "pago");
  await seedCommitment(1000, "empenhado");

  // Restos: inscrito em 2026 (ingresso 700), pago em 2026 (dispêndio 300).
  const c1 = await seedCommitment(700, "empenhado");
  await seedResto(c1, 700, "nao_processado", "2026-01-05", "inscrito", null);
  const c2 = await seedCommitment(300, "empenhado");
  await seedResto(c2, 300, "processado", "2025-01-05", "pago", "2026-03-10");

  const r = await fn.getFinancialBalance({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });

  assert.equal(r.ingressos.receita_orcamentaria, 9000);
  assert.equal(r.ingressos.extraorcamentario_restos_inscritos, 700);
  assert.equal(r.ingressos.total, 9700);

  assert.equal(r.dispendios.despesa_orcamentaria, 2000);
  assert.equal(r.dispendios.extraorcamentario_restos_pagos, 300);
  assert.equal(r.dispendios.total, 2300);

  // Resultado financeiro: 9700 − 2300 = 7400.
  assert.equal(r.resultado_financeiro, 7400);
});
