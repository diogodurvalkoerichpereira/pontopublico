/**
 * O3-04 (Onda 3) — contrato → orçamento: COMPORTAMENTO (ponta a ponta).
 *
 * O contrato administrativo (O3-01) passa a poder virar empenho real contra
 * dotação (O2-02), pelo mesmo primitivo `reserveOnAppropriation` da folha
 * (O2-04). Confere:
 *  - o empenho reserva saldo na dotação E no contrato (valor_empenhado sobe
 *    nos dois, em parcelas);
 *  - não empenha acima do saldo do contrato, mesmo com saldo de dotação sobrando;
 *  - só contrato vigente pode ser empenhado;
 *  - anular o empenho devolve o saldo reservado ao contrato e à dotação.
 *
 * Mutação: não devolver o saldo ao contrato na anulação (fica preso) derruba o
 * último teste.
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

const dir = mkdtempSync(join(tmpdir(), "contract-empenho-test-"));

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
  `const PERMS = ["budget.read","budget.manage","contracts.read","contracts.manage"];
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

async function seedDotacao(natureza, orcado, acao = "3001") {
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
        natureza_despesa: natureza,
        fonte_recurso: "1.500.0000",
        valor_orcado: orcado,
        status: "ativa",
      },
      context: ctx(),
    })
  ).id;
}

async function seedContract(over = {}) {
  return (
    await fn.saveContract({
      data: {
        tenant_id: tenantId,
        numero: over.numero ?? "010",
        ano: 2026,
        fornecedor: "Fornecedor LTDA",
        fornecedor_documento: "12.345.678/0001-90",
        objeto: "Serviço continuado de limpeza",
        modalidade: "pregao",
        valor_total: 100000,
        vigencia_inicio: "2026-01-01",
        vigencia_fim: "2026-12-31",
        status: "vigente",
        ...over,
      },
      context: ctx(),
    })
  ).id;
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
  Object.assign(fn, await bundle("src/lib/contracts.functions.ts", "c.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("empenho de contrato reserva saldo na dotação e no contrato, em parcelas", async () => {
  const dot = await seedDotacao("3.3.90.39.00", 500000);
  const contractId = await seedContract({ numero: "011" });

  const first = await fn.commitContractEmpenho({
    data: {
      tenant_id: tenantId,
      contract_id: contractId,
      appropriation_id: dot,
      data_empenho: "2026-02-01",
      valor: 30000,
    },
    context: ctx(),
  });
  assert.ok(first.id);

  const second = await fn.commitContractEmpenho({
    data: {
      tenant_id: tenantId,
      contract_id: contractId,
      appropriation_id: dot,
      data_empenho: "2026-03-01",
      valor: 20000,
    },
    context: ctx(),
  });
  assert.equal(second.numero, first.numero + 1);

  const { contracts } = await fn.getContracts({
    data: { tenant_id: tenantId, ano: 2026 },
    context: ctx(),
  });
  const contrato = contracts.find((c) => c.id === contractId);
  assert.equal(Number(contrato.valor_empenhado), 50000);
  assert.equal(Number(contrato.saldo), 50000);

  const { appropriations } = await fn.getBudgetAppropriations({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  const dotacao = appropriations.find((a) => a.id === dot);
  assert.equal(Number(dotacao.valor_empenhado), 50000);
});

test("não empenha contrato acima do próprio saldo, mesmo com dotação folgada", async () => {
  const dot = await seedDotacao("3.3.90.39.00", 1_000_000, "3002");
  const contractId = await seedContract({ numero: "012", valor_total: 10000 });

  await assert.rejects(
    fn.commitContractEmpenho({
      data: {
        tenant_id: tenantId,
        contract_id: contractId,
        appropriation_id: dot,
        data_empenho: "2026-02-01",
        valor: 15000,
      },
      context: ctx(),
    }),
    /excede o saldo do contrato/,
  );
});

test("só contrato vigente pode ser empenhado", async () => {
  const dot = await seedDotacao("3.3.90.39.00", 100000, "3003");
  const contractId = await seedContract({ numero: "013", status: "suspenso" });

  await assert.rejects(
    fn.commitContractEmpenho({
      data: {
        tenant_id: tenantId,
        contract_id: contractId,
        appropriation_id: dot,
        data_empenho: "2026-02-01",
        valor: 1000,
      },
      context: ctx(),
    }),
    /vigente/,
  );
});

test("anular o empenho de contrato devolve o saldo ao contrato e à dotação", async () => {
  const dot = await seedDotacao("3.3.90.39.00", 100000, "3004");
  const contractId = await seedContract({ numero: "014" });

  const commitment = await fn.commitContractEmpenho({
    data: {
      tenant_id: tenantId,
      contract_id: contractId,
      appropriation_id: dot,
      data_empenho: "2026-02-01",
      valor: 40000,
    },
    context: ctx(),
  });

  await fn.transitionBudgetCommitment({
    data: {
      tenant_id: tenantId,
      commitment_id: commitment.id,
      action: "anular",
      motivo: "Rescisão parcial",
    },
    context: ctx(),
  });

  const { contracts } = await fn.getContracts({
    data: { tenant_id: tenantId, ano: 2026 },
    context: ctx(),
  });
  const contrato = contracts.find((c) => c.id === contractId);
  assert.equal(Number(contrato.valor_empenhado), 0);
  assert.equal(Number(contrato.saldo), 100000);

  const { appropriations } = await fn.getBudgetAppropriations({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  const dotacao = appropriations.find((a) => a.id === dot);
  assert.equal(Number(dotacao.valor_empenhado), 0);
});
