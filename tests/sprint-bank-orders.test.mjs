/**
 * O2-16 (Onda 2) — ordem bancária (OB): COMPORTAMENTO.
 *
 * emitBankOrder paga um empenho LIQUIDADO por uma conta de tesouraria: numera a OB
 * por ente/exercício, gera a saída bancária (saldo nunca negativo) e leva o empenho a
 * 'pago'. Confere o pagamento, a numeração, a guarda de estágio (só liquidado paga),
 * o piso de saldo e a impossibilidade de pagar duas vezes.
 *
 * Mutação: somar em vez de subtrair o valor no saldo derruba o saldo_apos.
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

const dir = mkdtempSync(join(tmpdir(), "bank-orders-test-"));

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
  `const PERMS = ["accounting.read","accounting.manage"];
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
async function seedCommitment(valor, status) {
  numeroSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho,
        tipo, credor, historico, valor, status)
     values ($1,$2,$3,2026,$4,'2026-02-01','ordinario','Fornecedor X','Empenho',$5,$6)`,
    [id, tenantId, appropriationId, numeroSeq, valor, status],
  );
  return id;
}

let accSeq = 0;
async function seedAccount(saldo) {
  accSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.treasury_accounts (id, tenant_id, nome, tipo, saldo_atual)
     values ($1,$2,$3,'banco',$4)`,
    [id, tenantId, `Conta ${accSeq}`, saldo],
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
  appropriationId = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado, valor_empenhado)
     values ($1,$2,2026,'01','04','122','0001','2001','3.3.90.30','01',50000,50000)`,
    [appropriationId, tenantId],
  );
  Object.assign(fn, await bundle("src/lib/bank-orders.functions.ts", "bo.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("OB paga o empenho liquidado: numera, baixa o saldo e leva a 'pago'", async () => {
  const acc = await seedAccount(3000);
  const commitment = await seedCommitment(1000, "liquidado");
  const r = await fn.emitBankOrder({
    data: {
      tenant_id: tenantId,
      commitment_id: commitment,
      account_id: acc,
      data_emissao: "2026-03-10",
    },
    context: ctx(),
  });
  assert.equal(r.numero, 1);
  assert.equal(r.valor, 1000);
  assert.equal(r.saldo_apos, 2000); // 3000 - 1000

  // Empenho foi a 'pago'.
  const c = (
    await db.query("select status from public.budget_commitments where id=$1", [
      commitment,
    ])
  ).rows[0];
  assert.equal(c.status, "pago");

  // Gerou a saída bancária e baixou o saldo da conta.
  const mov = (
    await db.query(
      "select tipo, valor::text, saldo_apos::text from public.treasury_movements where account_id=$1",
      [acc],
    )
  ).rows[0];
  assert.equal(mov.tipo, "saida");
  assert.equal(mov.valor, "1000.00");
  assert.equal(mov.saldo_apos, "2000.00");
  const saldo = (
    await db.query(
      "select saldo_atual::text from public.treasury_accounts where id=$1",
      [acc],
    )
  ).rows[0];
  assert.equal(saldo.saldo_atual, "2000.00");

  // A OB aponta para o movimento gerado.
  const ob = (
    await db.query("select movement_id from public.bank_orders where id=$1", [
      r.id,
    ])
  ).rows[0];
  assert.ok(ob.movement_id);
});

test("só um empenho liquidado paga; saldo insuficiente recusa", async () => {
  const acc = await seedAccount(3000);
  const empenhado = await seedCommitment(500, "empenhado");
  await assert.rejects(
    fn.emitBankOrder({
      data: {
        tenant_id: tenantId,
        commitment_id: empenhado,
        account_id: acc,
        data_emissao: "2026-03-11",
      },
      context: ctx(),
    }),
    /liquidado/i,
  );

  const grande = await seedCommitment(9999, "liquidado");
  const contaPobre = await seedAccount(100);
  await assert.rejects(
    fn.emitBankOrder({
      data: {
        tenant_id: tenantId,
        commitment_id: grande,
        account_id: contaPobre,
        data_emissao: "2026-03-11",
      },
      context: ctx(),
    }),
    /negativo/i,
  );
});

test("numeração sequencial por exercício; um empenho paga uma só vez", async () => {
  const acc = await seedAccount(10000);
  const a = await seedCommitment(300, "liquidado");
  const b = await seedCommitment(400, "liquidado");
  const r1 = await fn.emitBankOrder({
    data: {
      tenant_id: tenantId,
      commitment_id: a,
      account_id: acc,
      data_emissao: "2026-04-01",
    },
    context: ctx(),
  });
  const r2 = await fn.emitBankOrder({
    data: {
      tenant_id: tenantId,
      commitment_id: b,
      account_id: acc,
      data_emissao: "2026-04-02",
    },
    context: ctx(),
  });
  assert.equal(r2.numero, r1.numero + 1);

  // Já pago não paga de novo (guarda de estágio + unique no banco).
  await assert.rejects(
    fn.emitBankOrder({
      data: {
        tenant_id: tenantId,
        commitment_id: a,
        account_id: acc,
        data_emissao: "2026-04-03",
      },
      context: ctx(),
    }),
    /liquidado/i,
  );
});
