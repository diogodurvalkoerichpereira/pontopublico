/**
 * Coerência restos a pagar × empenho × ordem bancária × balanço: COMPORTAMENTO.
 *
 * Defeitos corrigidos (auditoria do domínio financeiro):
 *  1. payRestoAPagar punha o empenho em 'pago' sem ler seu estado — pagava resto
 *     NÃO processado (sem liquidação, viola Lei 4.320 art. 62/63) e até empenho
 *     já anulado. Agora exige empenho liquidado e grava pago_em = data do pagamento.
 *  2. cancelRestoAPagar anulava empenho JÁ PAGO, apagando a despesa dos relatórios
 *     com o dinheiro fora do caixa. Agora recusa pago/anulado.
 *  3. emitBankOrder pagava o empenho e deixava o resto 'inscrito' — o mesmo
 *     empenho ficava "a pagar" e um pagamento posterior contava o dispêndio duas
 *     vezes. Agora a OB baixa o resto (e cancelBankOrder o reabre).
 *  4. getBudgetBalance somava resto pago/cancelado como "a pagar". Agora só inscrito.
 *
 * Mutação: retirar a guarda de estado do payRestoAPagar deixa pagar o resto não
 * processado — derruba.
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
let accountId;
let numeroSeq = 0;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "restos-coerencia-test-"));

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
const accStub = join(dir, "acc.mjs");
writeFileSync(
  accStub,
  `export async function contabilizarEvento() { return null; }
   export async function postEntry() { return { id: "x", valor: 0 }; }`,
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
        [/(^|\/)accounting\.(functions|server)$/, accStub],
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

async function seedCommitment(status, valor, exercicio = 2025) {
  const id = randomUUID();
  numeroSeq += 1;
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho, credor,
        historico, valor, status)
     values ($1,$2,$3,$4,$5,'2025-06-01','Credor X','Empenho',$6,$7)`,
    [id, tenantId, appropriationId, exercicio, numeroSeq, valor, status],
  );
  return id;
}
const inscrever = (exercicio = 2025) =>
  fn.inscribeRestosAPagar({
    data: {
      tenant_id: tenantId,
      exercicio,
      inscrito_em: "2025-12-31",
    },
    context: ctx(),
  });
const restoDoEmpenho = async (commitmentId) =>
  (
    await db.query(
      "select id, status, tipo, pago_em::text from public.restos_a_pagar where commitment_id=$1",
      [commitmentId],
    )
  ).rows[0];
const empenho = async (id) =>
  (
    await db.query(
      "select status, pago_em::date::text as pago_em from public.budget_commitments where id=$1",
      [id],
    )
  ).rows[0];

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
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado)
     values ($1,$2,2025,'01','04','122','0001','2001','3.3.90.30','1500',1000000)`,
    [appropriationId, tenantId],
  );
  accountId = randomUUID();
  await db.query(
    `insert into public.treasury_accounts (id, tenant_id, nome, tipo, saldo_atual)
     values ($1,$2,'Banco','banco',500000)`,
    [accountId, tenantId],
  );
  Object.assign(
    fn,
    await bundle("src/lib/restos-a-pagar.functions.ts", "r.mjs"),
    await bundle("src/lib/bank-orders.functions.ts", "ob.mjs"),
    await bundle("src/lib/budget-balance.functions.ts", "bb.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("resto NÃO processado não paga sem liquidação; processado paga e grava a data", async () => {
  const naoProcessado = await seedCommitment("empenhado", 1000);
  const processado = await seedCommitment("liquidado", 2000);
  await inscrever();

  const rNao = await restoDoEmpenho(naoProcessado);
  const rSim = await restoDoEmpenho(processado);
  assert.equal(rNao.tipo, "nao_processado");
  assert.equal(rSim.tipo, "processado");

  // Pagar o não processado é recusado: falta a liquidação (art. 62/63).
  await assert.rejects(
    fn.payRestoAPagar({
      data: {
        tenant_id: tenantId,
        resto_id: rNao.id,
        data_pagamento: "2026-03-10",
      },
      context: ctx(),
    }),
    /liquidado/i,
  );
  assert.equal((await empenho(naoProcessado)).status, "empenhado");

  // O processado paga e o empenho recebe pago_em = DATA DO PAGAMENTO.
  await fn.payRestoAPagar({
    data: {
      tenant_id: tenantId,
      resto_id: rSim.id,
      data_pagamento: "2026-03-10",
    },
    context: ctx(),
  });
  const e = await empenho(processado);
  assert.equal(e.status, "pago");
  assert.equal(e.pago_em, "2026-03-10");
});

test("cancelar resto não anula empenho já pago", async () => {
  const pago = await seedCommitment("liquidado", 3000);
  await inscrever();
  const r = await restoDoEmpenho(pago);
  await fn.payRestoAPagar({
    data: { tenant_id: tenantId, resto_id: r.id, data_pagamento: "2026-04-01" },
    context: ctx(),
  });
  // O resto já está pago (não inscrito) e o empenho pago: cancelar é recusado.
  await assert.rejects(
    fn.cancelRestoAPagar({
      data: {
        tenant_id: tenantId,
        resto_id: r.id,
        motivo: "prescricao",
        data_cancelamento: "2026-06-01",
      },
      context: ctx(),
    }),
    /inscrito|pago/i,
  );
  assert.equal((await empenho(pago)).status, "pago");
});

test("ordem bancária baixa o resto ao pagar e o reabre ao estornar", async () => {
  const c = await seedCommitment("liquidado", 4000);
  await inscrever();
  const r = await restoDoEmpenho(c);
  assert.equal(r.status, "inscrito");

  const ob = await fn.emitBankOrder({
    data: {
      tenant_id: tenantId,
      commitment_id: c,
      account_id: accountId,
      data_emissao: "2026-05-20",
    },
    context: ctx(),
  });
  // O resto foi baixado junto com o pagamento — sem isso o dispêndio contava 2x.
  const depois = await restoDoEmpenho(c);
  assert.equal(depois.status, "pago");
  assert.equal(depois.pago_em, "2026-05-20");

  await fn.cancelBankOrder({
    data: {
      tenant_id: tenantId,
      order_id: ob.id,
      data_estorno: "2026-05-25",
      motivo: "estorno de teste",
    },
    context: ctx(),
  });
  const reaberto = await restoDoEmpenho(c);
  assert.equal(reaberto.status, "inscrito");
  assert.equal(reaberto.pago_em, null);
  assert.equal((await empenho(c)).status, "liquidado");
});

test("balanço orçamentário conta como restos a pagar só os INSCRITOS", async () => {
  const bal = await fn.getBudgetBalance({
    data: { tenant_id: tenantId, exercicio: 2025 },
    context: ctx(),
  });
  // Inscritos de 2025 que seguem em aberto: o não processado (1000) e o do
  // teste da OB, reaberto pelo estorno (4000). Os pagos (2000 e 3000) saíram.
  assert.equal(bal.restos_a_pagar.nao_processados, 1000);
  assert.equal(bal.restos_a_pagar.processados, 4000);
  assert.equal(bal.restos_a_pagar.total, 5000);
});
