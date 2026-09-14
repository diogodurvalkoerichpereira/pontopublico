/**
 * O2-06 (Onda 2) — contabilização automática por fato: COMPORTAMENTO (ponta a ponta).
 *
 * Com o roteiro configurado (accounting_event_accounts), empenhar/liquidar/pagar
 * geram lançamentos contábeis balanceados no razão (O2-05). Confere que cada fato
 * contabiliza com o valor certo e que sem roteiro nada é lançado.
 *
 * Mutação: não chamar a contabilização no empenho derruba.
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

const dir = mkdtempSync(join(tmpdir(), "acc-routing-test-"));

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
  `const PERMS = ["budget.read","budget.manage","accounting.read","accounting.manage"];
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

let contaId;
const ctx = () => ({ userId });

async function seedDotacao(acao) {
  return (
    await fn.saveBudgetAppropriation({
      data: {
        tenant_id: tenantId,
        exercicio: 2026,
        unidade_orcamentaria: "02.01",
        funcao: "04",
        subfuncao: "122",
        programa: "0001",
        acao,
        natureza_despesa: "3.1.90.11.00",
        fonte_recurso: "1.500.0000",
        valor_orcado: 100000,
        status: "ativa",
      },
      context: ctx(),
    })
  ).id;
}
const empenhar = (appropriation_id, valor) =>
  fn.createBudgetCommitment({
    data: {
      tenant_id: tenantId,
      appropriation_id,
      data_empenho: "2026-03-15",
      credor: "Fornecedor",
      historico: "Compra",
      valor,
    },
    context: ctx(),
  });
const move = (commitment_id, action) =>
  fn.transitionBudgetCommitment({
    data: { tenant_id: tenantId, commitment_id, action },
    context: ctx(),
  });
async function entryCount() {
  return Number(
    (
      await db.query(
        "select count(*)::int as n from public.accounting_entries where tenant_id=$1",
        [tenantId],
      )
    ).rows[0].n,
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
  Object.assign(fn, await bundle("src/lib/budget.functions.ts", "b.mjs"));
  Object.assign(fn, await bundle("src/lib/accounting.functions.ts", "a.mjs"));
  Object.assign(fn, await bundle("src/lib/bank-orders.functions.ts", "ob.mjs"));
  // Conta de tesouraria: o pagamento é da ordem bancária, que debita o caixa.
  contaId = randomUUID();
  await db.query(
    `insert into public.treasury_accounts (id, tenant_id, nome, tipo, saldo_atual)
     values ($1,$2,'Banco','banco',1000000)`,
    [contaId, tenantId],
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("sem roteiro configurado, o fato não contabiliza", async () => {
  const dot = await seedDotacao("2001");
  await empenhar(dot, 1000);
  assert.equal(await entryCount(), 0);
});

test("com roteiro, empenho→liquidação→pagamento geram lançamentos balanceados", async () => {
  for (const [ev, d, c] of [
    ["empenho", "6.2.2.1.1", "5.2.2.1.1"],
    ["liquidacao", "6.2.2.1.3", "6.2.2.1.1"],
    ["pagamento", "2.1.1.1.1", "1.1.1.1.1"],
  ]) {
    await fn.saveAccountingEventAccount({
      data: {
        tenant_id: tenantId,
        event_code: ev,
        debit_account: d,
        credit_account: c,
      },
      context: ctx(),
    });
  }
  const antes = await entryCount();
  const dot = await seedDotacao("2002");
  const { id } = await empenhar(dot, 3000);
  await move(id, "liquidar");
  // O pagamento é da OB (única via que move o caixa); gera o evento 'pagamento'.
  await fn.emitBankOrder({
    data: {
      tenant_id: tenantId,
      commitment_id: id,
      account_id: contaId,
      data_emissao: "2026-03-01",
    },
    context: ctx(),
  });
  // 3 fatos -> 3 lançamentos.
  assert.equal(await entryCount(), antes + 3);

  const balanceados = (
    await db.query(
      `select e.id,
         coalesce(sum(case when l.lado='D' then l.valor else -l.valor end),0) as saldo
       from public.accounting_entries e
       join public.accounting_entry_lines l on l.entry_id=e.id
       where e.tenant_id=$1 group by e.id`,
      [tenantId],
    )
  ).rows;
  assert.ok(
    balanceados.every((r) => Number(r.saldo) === 0),
    "todo lançamento tem de fechar em zero",
  );
});
