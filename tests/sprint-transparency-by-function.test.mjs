/**
 * O5-02b (Onda 5) — despesa por função de governo (transparência): COMPORTAMENTO.
 *
 * getTransparencyByFunction agrega a execução da despesa (empenhado não anulado,
 * liquidado, pago) pela FUNÇÃO da classificação da dotação, com totais. Empenho
 * anulado não conta; função sem empenho não aparece; ordena pelo maior empenhado.
 *
 * Mutação: incluir 'anulado' no empenhado, ou não filtrar a função (misturar),
 * derruba.
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

const dir = mkdtempSync(join(tmpdir(), "transp-func-test-"));

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

let numeroSeq = 0;
async function seedAppropriation(funcao, unidade) {
  const id = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id,tenant_id,exercicio,unidade_orcamentaria,funcao,subfuncao,programa,acao,natureza_despesa,fonte_recurso,valor_orcado,valor_empenhado)
     values ($1,$2,2026,$3,$4,'122','0001','2001','3.3.90.30','1.500',1000000,0)`,
    [id, tenantId, unidade, funcao],
  );
  return id;
}
async function seedCommitment(appropriationId, valor, status) {
  numeroSeq += 1;
  await db.query(
    `insert into public.budget_commitments
       (id,tenant_id,appropriation_id,exercicio,numero,data_empenho,tipo,credor,historico,valor,status)
     values ($1,$2,$3,2026,$4,'2026-03-01','ordinario','X','h',$5,$6)`,
    [randomUUID(), tenantId, appropriationId, numeroSeq, valor, status],
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

  // Função 10 (Saúde) em DUAS unidades diferentes — devem somar numa só linha.
  const saudeA = await seedAppropriation("10", "02.01");
  await seedCommitment(saudeA, 30000, "pago");
  await seedCommitment(saudeA, 20000, "empenhado");
  await seedCommitment(saudeA, 99999, "anulado"); // fora
  const saudeB = await seedAppropriation("10", "03.02");
  await seedCommitment(saudeB, 5000, "pago");
  // Função 12 (Educação): 10000 liquidado.
  const educ = await seedAppropriation("12", "04.01");
  await seedCommitment(educ, 10000, "liquidado");

  Object.assign(fn, await bundle("src/lib/transparency.functions.ts", "t.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("despesa por função: exclui anulado, ordena por empenhado, totais batem", async () => {
  const r = await fn.getTransparencyByFunction({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });

  // Saúde é UMA linha só (duas unidades somadas), antes de Educação.
  assert.equal(r.funcoes.length, 2);
  assert.equal(r.funcoes[0].funcao, "10");
  assert.equal(r.funcoes[0].empenhado, 55000); // 30000 + 20000 + 5000 (sem os anulados)
  assert.equal(r.funcoes[0].liquidado, 35000); // pagos: 30000 + 5000
  assert.equal(r.funcoes[0].pago, 35000);

  const educ = r.funcoes.find((f) => f.funcao === "12");
  assert.equal(educ.empenhado, 10000);
  assert.equal(educ.liquidado, 10000);
  assert.equal(educ.pago, 0);

  assert.equal(r.totais.empenhado, 65000);
  assert.equal(r.totais.liquidado, 45000);
  assert.equal(r.totais.pago, 35000);
});
