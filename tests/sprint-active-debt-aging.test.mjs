/**
 * O4-14b (Onda 5) — aging do estoque da dívida ativa: COMPORTAMENTO.
 *
 * getActiveDebtAging distribui as CDAs em cobrança (status 'ativa') por exercício de origem
 * e por faixa etária (idade = ano_referencia − exercício): no exercício, 1–2, 3–5, mais de 5.
 * CDA quitada/cancelada não é estoque. Consolida total.
 *
 * Mutação: incluir CDA não-ativa (remover o filtro status='ativa') infla o estoque — derruba.
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

const dir = mkdtempSync(join(tmpdir(), "cda-aging-test-"));

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
  `const PERMS = ["taxes.read","taxes.manage"];
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

let seq = 0;
async function seedCda(exercicio, valor, status) {
  seq += 1;
  const creditId = randomUUID();
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',$3,'Contribuinte','00000000000',$4,$5,0,$6,'divida_ativa')`,
    [creditId, tenantId, exercicio, `INSC-${seq}`, valor, `${exercicio}-01-01`],
  );
  await db.query(
    `insert into public.active_debt_certificates
       (id, tenant_id, exercicio, numero, credit_id, valor_inscrito,
        data_inscricao, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      tenantId,
      exercicio,
      seq,
      creditId,
      valor,
      `${exercicio}-03-01`,
      status,
    ],
  );
}

const aging = () =>
  fn.getActiveDebtAging({
    data: { tenant_id: tenantId, ano_referencia: 2026 },
    context: ctx(),
  });

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
    await bundle("src/lib/active-debt-certificate.functions.ts", "cda.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("distribui o estoque ativo por exercício e faixa etária; ignora não-ativa", async () => {
  await seedCda(2026, 1000, "ativa"); // idade 0 → no_exercicio
  await seedCda(2025, 500, "ativa"); // idade 1 → de_1_a_2
  await seedCda(2022, 300, "ativa"); // idade 4 → de_3_a_5
  await seedCda(2018, 800, "ativa"); // idade 8 → mais_de_5
  await seedCda(2020, 9999, "quitada"); // fora do estoque
  await seedCda(2019, 7777, "cancelada"); // fora do estoque

  const r = await aging();
  assert.equal(r.faixas.no_exercicio.valor, 1000);
  assert.equal(r.faixas.de_1_a_2.valor, 500);
  assert.equal(r.faixas.de_3_a_5.valor, 300);
  assert.equal(r.faixas.mais_de_5.valor, 800);
  assert.equal(r.faixas.mais_de_5.quantidade, 1);
  assert.equal(r.total.valor, 2600);
  assert.equal(r.total.quantidade, 4);
  assert.equal(r.porExercicio.length, 4);
});
