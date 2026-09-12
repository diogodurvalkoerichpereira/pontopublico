/**
 * O2-16b (Onda 2) — cancelamento (estorno) de ordem bancária: COMPORTAMENTO.
 *
 * cancelBankOrder estorna uma OB paga: devolve o valor à conta de tesouraria
 * (ingresso), devolve o empenho ao estágio 'liquidado' e marca a OB 'cancelada'.
 * Só uma OB 'paga' cancela; cancelar de novo é recusado.
 *
 * Mutação: não devolver o valor à conta (saldo não restaura) ou não reverter o
 * empenho a 'liquidado' derruba.
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

const dir = mkdtempSync(join(tmpdir(), "bank-order-cancel-test-"));

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

test("estorno de OB paga: devolve saldo, volta empenho a liquidado, OB cancelada", async () => {
  const acc = await seedAccount(3000);
  const commitment = await seedCommitment(1000, "liquidado");
  const ob = await fn.emitBankOrder({
    data: {
      tenant_id: tenantId,
      commitment_id: commitment,
      account_id: acc,
      data_emissao: "2026-03-10",
    },
    context: ctx(),
  });
  // Estado pós-pagamento: saldo 2000, empenho pago.
  const r = await fn.cancelBankOrder({
    data: {
      tenant_id: tenantId,
      order_id: ob.id,
      data_estorno: "2026-03-15",
      motivo: "pagamento indevido",
    },
    context: ctx(),
  });
  assert.equal(r.status, "cancelada");
  assert.equal(r.saldo_apos, 3000); // 2000 + 1000 devolvido

  // Conta restaurada ao saldo original.
  const saldo = (
    await db.query(
      "select saldo_atual::text from public.treasury_accounts where id=$1",
      [acc],
    )
  ).rows[0];
  assert.equal(saldo.saldo_atual, "3000.00");

  // Empenho voltou a 'liquidado', sem pago_em.
  const c = (
    await db.query(
      "select status, pago_em from public.budget_commitments where id=$1",
      [commitment],
    )
  ).rows[0];
  assert.equal(c.status, "liquidado");
  assert.equal(c.pago_em, null);

  // OB cancelada e um ingresso de estorno registrado.
  const o = (
    await db.query("select status from public.bank_orders where id=$1", [ob.id])
  ).rows[0];
  assert.equal(o.status, "cancelada");
  const ingresso = (
    await db.query(
      "select count(*)::int n from public.treasury_movements where account_id=$1 and tipo='ingresso'",
      [acc],
    )
  ).rows[0];
  assert.equal(ingresso.n, 1);
});

test("só OB paga cancela; cancelar de novo é recusado", async () => {
  const acc = await seedAccount(5000);
  const commitment = await seedCommitment(700, "liquidado");
  const ob = await fn.emitBankOrder({
    data: {
      tenant_id: tenantId,
      commitment_id: commitment,
      account_id: acc,
      data_emissao: "2026-05-01",
    },
    context: ctx(),
  });
  await fn.cancelBankOrder({
    data: { tenant_id: tenantId, order_id: ob.id, data_estorno: "2026-05-02" },
    context: ctx(),
  });
  // Segunda tentativa: a OB já está cancelada.
  await assert.rejects(
    fn.cancelBankOrder({
      data: {
        tenant_id: tenantId,
        order_id: ob.id,
        data_estorno: "2026-05-03",
      },
      context: ctx(),
    }),
    /paga/i,
  );
});
