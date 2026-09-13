/**
 * O2-22b (Onda 5) — excesso de arrecadação disponível por fonte: COMPORTAMENTO.
 *
 * getExcessRevenueAvailable devolve, por fonte com excesso (arrecadado > previsto), o
 * previsto/arrecadado/excesso, o já utilizado em créditos suplementares e o disponível
 * (excesso − utilizado). Fonte sem excesso (déficit ou zero) não aparece.
 *
 * Mutação: inverter o excesso para previsto − arrecadado zera as fontes com excesso — derruba.
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
let destinoId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "excess-revenue-test-"));

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

async function seedRevenue(fonte, previsto, arrecadado, natSuffix) {
  await db.query(
    `insert into public.budget_revenues
       (id, tenant_id, exercicio, natureza_receita, fonte_recurso, descricao,
        valor_previsto, valor_arrecadado)
     values ($1,$2,2026,$3,$4,'Receita',$5,$6)`,
    [randomUUID(), tenantId, `1.1.${natSuffix}`, fonte, previsto, arrecadado],
  );
}
async function seedCredit(fonte, valor) {
  await db.query(
    `insert into public.budget_supplementary_credits
       (id, tenant_id, exercicio, destino_id, fonte_recurso, valor,
        justificativa, data_referencia, created_by)
     values ($1,$2,2026,$3,$4,$5,'Suplementacao','2026-06-01',$6)`,
    [randomUUID(), tenantId, destinoId, fonte, valor, userId],
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
  destinoId = randomUUID();
  await db.query(
    `insert into public.budget_appropriations
       (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
        programa, acao, natureza_despesa, fonte_recurso, valor_orcado, valor_empenhado)
     values ($1,$2,2026,'01','04','122','0001','2001','3.3.90.30','AA',1000,0)`,
    [destinoId, tenantId],
  );
  Object.assign(
    fn,
    await bundle("src/lib/supplementary-credit.functions.ts", "sc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("lista fontes com excesso e o disponível; ignora déficit e excesso zerado", async () => {
  await seedRevenue("AA", 1000, 1500, "1"); // excesso 500
  await seedCredit("AA", 200); // já utilizado 200 → disponível 300
  await seedRevenue("BB", 2000, 1800, "2"); // déficit: fora
  await seedRevenue("CC", 500, 500, "3"); // excesso zero: fora

  const r = await fn.getExcessRevenueAvailable({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  assert.equal(r.fontes.length, 1);
  const aa = r.fontes[0];
  assert.equal(aa.fonte_recurso, "AA");
  assert.equal(aa.excesso, 500);
  assert.equal(aa.utilizado, 200);
  assert.equal(aa.disponivel, 300);
  assert.equal(r.totalDisponivel, 300);
});
