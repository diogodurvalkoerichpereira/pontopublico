/**
 * O2-23 (Onda 2) — contingenciamento / limitação de empenho (LRF art. 9): COMPORTAMENTO.
 *
 * contingenciarDotacao bloqueia parte da dotação sem invadir o já empenhado
 * (empenhado + bloqueado ≤ orçado); descontingenciar libera sem deixar o bloqueado
 * negativo. O saldo empenhável de getBudgetAppropriations desconta o bloqueado. Confere
 * o bloqueio, o teto, a liberação e o efeito no saldo.
 *
 * Mutação: não descontar o bloqueado do saldo empenhável derruba o teste.
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
let dotacaoId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "budget-contingency-test-"));

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
  dotacaoId = randomUUID();
  // Dotação orçada 1000, já empenhada 200.
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado, valor_empenhado)
     values ($1,$2,2026,'01','04','122','0001','2001','3.3.90.30','01',1000,200)`,
    [dotacaoId, tenantId],
  );
  Object.assign(
    fn,
    await bundle("src/lib/budget-contingency.functions.ts", "bc.mjs"),
  );
  Object.assign(fn, await bundle("src/lib/budget.functions.ts", "bf.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const contingenciar = (valor) =>
  fn.contingenciarDotacao({
    data: {
      tenant_id: tenantId,
      appropriation_id: dotacaoId,
      valor,
      motivo: "Frustracao de arrecadacao (LRF art. 9)",
    },
    context: ctx(),
  });

const saldoDe = async () => {
  const r = await fn.getBudgetAppropriations({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  return Number(r.appropriations.find((a) => a.id === dotacaoId).saldo);
};

test("bloqueia e reduz o saldo empenhável; não invade o empenhado", async () => {
  // Saldo empenhável inicial: 1000 − 200 = 800.
  assert.equal(await saldoDe(), 800);

  const r = await contingenciar(300);
  assert.equal(r.valor_bloqueado, 300);
  // Saldo agora desconta o bloqueado: 1000 − 200 − 300 = 500.
  assert.equal(await saldoDe(), 500);

  // Empenhado 200 + bloqueado 300 = 500; bloquear mais 600 invadiria o empenhado
  // (livre = 1000 − 500 = 500): recusa.
  await assert.rejects(contingenciar(600), /invadiria/i);
});

test("libera o contingenciado; não pode liberar além do bloqueado", async () => {
  await fn.descontingenciarDotacao({
    data: {
      tenant_id: tenantId,
      appropriation_id: dotacaoId,
      valor: 100,
      motivo: "Reprogramacao",
    },
    context: ctx(),
  });
  // Bloqueado 300 − 100 = 200; saldo 1000 − 200 − 200 = 600.
  assert.equal(await saldoDe(), 600);

  await assert.rejects(
    fn.descontingenciarDotacao({
      data: {
        tenant_id: tenantId,
        appropriation_id: dotacaoId,
        valor: 999,
        motivo: "Liberacao acima do bloqueado",
      },
      context: ctx(),
    }),
    /excede o bloqueado/i,
  );
});
