/**
 * O2-10 (Onda 2) — balanço orçamentário (Lei 4.320): COMPORTAMENTO.
 *
 * getBudgetBalance consolida receita (prevista/arrecadada), despesa (fixada/
 * empenhada/liquidada/paga) e o resultado orçamentário (arrecadada − empenhada),
 * com múltiplas dotações/empenhos e sem inflar soma por fan-out.
 *
 * Mutação: contar empenho anulado na despesa empenhada derruba os totais.
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
let numeroSeq = 0;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "balance-test-"));

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

async function seedAppropriation(orcado, acao) {
  const id = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado)
     values ($1,$2,2025,'01','04','122','0001',$3,'3.3.90.30','1500',$4)`,
    [id, tenantId, acao, orcado],
  );
  return id;
}

async function seedCommitment(appropriationId, status, valor) {
  numeroSeq += 1;
  await db.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho, credor,
        historico, valor, status)
     values ($1,$2,$3,2025,$4,'2025-06-01','Credor','Empenho',$5,$6)`,
    [randomUUID(), tenantId, appropriationId, numeroSeq, valor, status],
  );
}

async function seedRevenue(natureza, previsto, arrecadado) {
  await db.query(
    `insert into public.budget_revenues
       (id, tenant_id, exercicio, natureza_receita, fonte_recurso, descricao,
        valor_previsto, valor_arrecadado)
     values ($1,$2,2025,$3,'1500','Receita',$4,$5)`,
    [randomUUID(), tenantId, natureza, previsto, arrecadado],
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
  Object.assign(
    fn,
    await bundle("src/lib/budget-balance.functions.ts", "b.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("consolida receita, despesa e resultado orçamentário", async () => {
  // Receita: prevista 1000, arrecadada 900.
  await seedRevenue("1.1.1", 600, 500);
  await seedRevenue("1.2.1", 400, 400);
  // Despesa: duas dotações (fixada 1000). Empenhos em vários estados.
  const d1 = await seedAppropriation(700, "2001");
  const d2 = await seedAppropriation(300, "2002");
  await seedCommitment(d1, "pago", 200); // empenhada+liquidada+paga
  await seedCommitment(d1, "liquidado", 100); // empenhada+liquidada
  await seedCommitment(d2, "empenhado", 50); // empenhada só
  await seedCommitment(d2, "anulado", 999); // não conta

  const b = await fn.getBudgetBalance({
    data: { tenant_id: tenantId, exercicio: 2025 },
    context: ctx(),
  });
  assert.equal(b.receita.prevista, 1000);
  assert.equal(b.receita.arrecadada, 900);
  assert.equal(b.receita.diferenca, -100);
  assert.equal(b.despesa.fixada, 1000);
  assert.equal(b.despesa.empenhada, 350); // 200+100+50, anulado fora
  assert.equal(b.despesa.liquidada, 300); // 200+100
  assert.equal(b.despesa.paga, 200);
  assert.equal(b.despesa.saldo_dotacao, 650); // 1000-350
  assert.equal(b.resultado_orcamentario, 550); // 900-350
});

test("exercício sem dados zera tudo", async () => {
  const b = await fn.getBudgetBalance({
    data: { tenant_id: tenantId, exercicio: 2099 },
    context: ctx(),
  });
  assert.equal(b.receita.prevista, 0);
  assert.equal(b.despesa.empenhada, 0);
  assert.equal(b.resultado_orcamentario, 0);
});
