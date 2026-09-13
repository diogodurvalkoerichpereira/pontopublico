/**
 * O2-17 (Onda 2) — Demonstração dos Fluxos de Caixa (MCASP): COMPORTAMENTO.
 *
 * getCashFlowStatement classifica arrecadação (sem estornos) e despesa paga em
 * operacional / investimento / financiamento pela natureza codificada, apura a
 * geração líquida e a concilia com a variação do caixa da tesouraria.
 *
 * Mutação: classificar a amortização da dívida (4.6) como investimento (retirar
 * a exceção `<> '46'`) muda os dois fluxos — derruba.
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

const dir = mkdtempSync(join(tmpdir(), "dfc-test-"));

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
  `const PERMS = ["budget.read"];
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

// Receita: cria a natureza e arrecada `valor` em 2026 (opcionalmente estornada).
async function collect(natureza, valor, estornada = false) {
  const rid = randomUUID();
  await db.query(
    `insert into public.budget_revenues
       (id, tenant_id, exercicio, natureza_receita, fonte_recurso, descricao,
        valor_previsto, valor_arrecadado)
     values ($1,$2,2026,$3,'01','R',0,0)`,
    [rid, tenantId, natureza],
  );
  await db.query(
    `insert into public.revenue_collections
       (id, tenant_id, revenue_id, data_arrecadacao, valor, historico, estornada)
     values ($1,$2,$3,'2026-05-10',$4,'A',$5)`,
    [randomUUID(), tenantId, rid, valor, estornada],
  );
}

// Despesa: dotação na natureza e um empenho com o status dado.
let seq = 0;
async function spend(natureza, valor, status = "pago") {
  seq += 1;
  const aid = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado, valor_empenhado)
     values ($1,$2,2026,'01','04','122','0001','2001',$3,'01',1000000,0)`,
    [aid, tenantId, natureza],
  );
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho,
        tipo, credor, historico, valor, status)
     values ($1,$2,$3,2026,$4,'2026-02-01','ordinario','F','E',$5,$6)`,
    [randomUUID(), tenantId, aid, seq, valor, status],
  );
}

// Tesouraria: movimento numa conta única (saldo_apos só precisa existir).
let accountId;
async function move(tipo, valor, data) {
  await db.query(
    `insert into public.treasury_movements
       (id, tenant_id, account_id, tipo, data_movimento, valor, historico, saldo_apos)
     values ($1,$2,$3,$4,$5::date,$6,'M',0)`,
    [randomUUID(), tenantId, accountId, tipo, data, valor],
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
  accountId = randomUUID();
  await db.query(
    `insert into public.treasury_accounts (id, tenant_id, nome, tipo, saldo_atual)
     values ($1,$2,'Banco','banco',0)`,
    [accountId, tenantId],
  );
  Object.assign(
    fn,
    await bundle("src/lib/cash-flow-statement.functions.ts", "dfc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("classifica os fluxos pela natureza, apura a geração líquida e concilia com o caixa", async () => {
  // Ingressos: corrente 9000 (op.), estornada 500 não conta, alienação 1500 (inv.),
  // operação de crédito 4000 (fin.), transferência de capital 800 (op., MCASP).
  await collect("1.1.1.8", 9000);
  await collect("1.7.1.8", 500, true);
  await collect("2.2.1.3", 1500);
  await collect("2.1.1.1", 4000);
  await collect("2.4.1.8", 800);
  // Desembolsos pagos: corrente 2000 + juros da dívida 300 (op.), investimento
  // 2500 (inv.), amortização 1000 (fin.); empenhado-não-pago 700 não conta.
  await spend("3.3.90.30", 2000);
  await spend("3.2.90.21", 300);
  await spend("4.4.90.51", 2500);
  await spend("4.6.90.71", 1000);
  await spend("3.3.90.39", 700, "empenhado");
  // Caixa: 10000 antes do exercício; no exercício entra 15300 e sai 5800.
  await move("ingresso", 10000, "2025-12-20");
  await move("ingresso", 15300, "2026-05-10");
  await move("saida", 5800, "2026-06-15");

  const r = await fn.getCashFlowStatement({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });

  assert.deepEqual(r.operacional, {
    ingressos: 9800,
    desembolsos: 2300,
    liquido: 7500,
  });
  assert.deepEqual(r.investimento, {
    ingressos: 1500,
    desembolsos: 2500,
    liquido: -1000,
  });
  assert.deepEqual(r.financiamento, {
    ingressos: 4000,
    desembolsos: 1000,
    liquido: 3000,
  });
  // Geração líquida: 7500 − 1000 + 3000 = 9500 = variação do caixa (15300 − 5800).
  assert.equal(r.geracao_liquida, 9500);
  assert.equal(r.caixa_inicial, 10000);
  assert.equal(r.caixa_final, 19500);
  assert.equal(r.variacao_caixa, 9500);
  assert.equal(r.conciliado, true);

  // Uma saída de caixa sem despesa paga correspondente desconcilia a DFC.
  await move("saida", 250, "2026-09-01");
  const r2 = await fn.getCashFlowStatement({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  assert.equal(r2.geracao_liquida, 9500);
  assert.equal(r2.variacao_caixa, 9250);
  assert.equal(r2.conciliado, false);
});
