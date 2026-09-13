/**
 * O5-02c (Onda 5) — dados abertos do Portal da Transparência: COMPORTAMENTO.
 *
 * getOpenDataTransparencia empacota, num payload autodescritivo (formato/versão/
 * licença/ente/gerado_em), a despesa por função, a despesa por credor e a
 * receita do exercício — mesmas regras de exclusão de empenho anulado e de
 * "sem saldo empenhado não aparece" já valem para O5-02b.
 *
 * Mutação: incluir 'anulado' no empenhado por credor, ou não filtrar o
 * exercício, derruba.
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

const dir = mkdtempSync(join(tmpdir(), "transp-opendata-test-"));

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
async function seedCommitment(
  appropriationId,
  credor,
  valor,
  status,
  exercicio = 2026,
) {
  numeroSeq += 1;
  await db.query(
    `insert into public.budget_commitments
       (id,tenant_id,appropriation_id,exercicio,numero,data_empenho,tipo,credor,historico,valor,status)
     values ($1,$2,$3,$4,$5,'2026-03-01','ordinario',$6,'h',$7,$8)`,
    [
      randomUUID(),
      tenantId,
      appropriationId,
      exercicio,
      numeroSeq,
      credor,
      valor,
      status,
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

  const saude = await seedAppropriation("10", "02.01");
  await seedCommitment(saude, "Fornecedor A", 30000, "pago");
  await seedCommitment(saude, "Fornecedor B", 20000, "empenhado");
  await seedCommitment(saude, "Fornecedor A", 99999, "anulado"); // fora de tudo
  // Credor com empenho só em outro exercício não deve aparecer em 2026.
  await seedCommitment(saude, "Fornecedor Fora", 5000, "pago", 2025);

  await db.query(
    `insert into public.budget_revenues
       (id, tenant_id, exercicio, natureza_receita, fonte_recurso, descricao, valor_previsto, valor_arrecadado)
     values ($1,$2,2026,'1.1.1.8','1.500','Receita teste',500000,120000)`,
    [randomUUID(), tenantId],
  );

  Object.assign(fn, await bundle("src/lib/transparency.functions.ts", "t.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("dados abertos: envelope com metadados, exclui anulado e credor fora do exercício", async () => {
  const r = await fn.getOpenDataTransparencia({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });

  assert.equal(r.formato, "dados-abertos-transparencia");
  assert.equal(r.exercicio, 2026);
  assert.ok(r.ente && typeof r.ente.nome === "string");
  assert.ok(typeof r.gerado_em === "string" && r.gerado_em.length > 0);

  assert.equal(r.despesa_por_funcao.length, 1);
  assert.equal(r.despesa_por_funcao[0].funcao, "10");
  assert.equal(r.despesa_por_funcao[0].empenhado, 50000); // 30000 + 20000, sem o anulado

  assert.equal(r.despesa_por_credor.length, 2);
  const a = r.despesa_por_credor.find((c) => c.credor === "Fornecedor A");
  const b = r.despesa_por_credor.find((c) => c.credor === "Fornecedor B");
  assert.equal(a.empenhado, 30000); // sem o anulado
  assert.equal(a.pago, 30000);
  assert.equal(b.empenhado, 20000);
  assert.ok(!r.despesa_por_credor.some((c) => c.credor === "Fornecedor Fora"));

  assert.equal(r.receita.previsto, 500000);
  assert.equal(r.receita.arrecadado, 120000);
});
