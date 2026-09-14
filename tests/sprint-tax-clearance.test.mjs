/**
 * O4-03 (Onda 4) — regularidade fiscal (base da CND): COMPORTAMENTO.
 *
 * checkTaxClearance devolve "regular" quando o contribuinte não tem débito em
 * aberto e "com_debitos" (com saldo e flag de dívida ativa) quando tem. Confere
 * que crédito quitado não conta e que dívida ativa acende a pendência.
 *
 * Mutação: ignorar o filtro de saldo (contar crédito quitado) derruba.
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

const dir = mkdtempSync(join(tmpdir(), "tax-clear-test-"));

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

async function seedCredit(
  doc,
  inscricao,
  lancado,
  pago,
  status,
  vencimento = "2024-05-01",
) {
  await db.query(
    `insert into public.tax_credits
       (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
        inscricao, valor_lancado, valor_pago, vencimento, status)
     values ($1,$2,'IPTU',2024,'Fulano',$3,$4,$5,$6,$8,$7)`,
    [randomUUID(), tenantId, doc, inscricao, lancado, pago, status, vencimento],
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
    await bundle("src/lib/tax-clearance.functions.ts", "tc.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const check = (doc) =>
  fn.checkTaxClearance({
    data: { tenant_id: tenantId, contribuinte_documento: doc },
    context: ctx(),
  });

test("contribuinte só com crédito quitado é regular", async () => {
  await seedCredit("111", "Q-1", 200, 200, "quitado");
  const r = await check("111");
  assert.equal(r.situacao, "regular");
  assert.equal(r.saldo_total, 0);
  assert.equal(r.em_divida_ativa, false);
  assert.equal(r.debts.length, 0);
});

test("dívida ativa com saldo acende a pendência", async () => {
  await seedCredit("222", "DA-1", 300, 100, "divida_ativa");
  await seedCredit("222", "Q-2", 50, 50, "quitado"); // quitado não conta
  const r = await check("222");
  assert.equal(r.situacao, "com_debitos");
  assert.equal(r.saldo_total, 200);
  assert.equal(r.em_divida_ativa, true);
  assert.equal(r.debts.length, 1);
});

test("documento com máscara acha o débito do mesmo contribuinte", async () => {
  // O cadastro grava ora com máscara, ora sem. Comparar a string crua devolvia
  // "regular" para quem devia — o pior erro possível numa certidão.
  await seedCredit("529.982.247-25", "M-1", 500, 0, "lancado");
  const semMascara = await check("52998224725");
  assert.equal(semMascara.situacao, "com_debitos");
  assert.equal(semMascara.saldo_total, 500);
  const comMascara = await check("529.982.247-25");
  assert.equal(comMascara.situacao, "com_debitos");
});

test("crédito a vencer não impede a certidão, mas aparece no extrato", async () => {
  // CTN art. 205: a certidão atesta débito EXIGÍVEL. Lançar o IPTU do exercício
  // não pode bloquear a CND de todo o município até o vencimento.
  await seedCredit("444", "AV-1", 700, 0, "lancado", "2999-12-31");
  const r = await check("444");
  assert.equal(r.situacao, "regular_com_ressalva");
  assert.equal(r.saldo_exigivel, 0);
  assert.equal(r.saldo_a_vencer, 700);
  assert.equal(r.saldo_total, 700);
  assert.equal(r.debts.length, 1);
  assert.equal(r.debts[0].vencido, false);
});

test("vencido junto com a vencer rebaixa para com_debitos", async () => {
  await seedCredit("555", "AV-2", 100, 0, "lancado", "2999-12-31");
  await seedCredit("555", "VE-1", 300, 0, "lancado", "2024-01-10");
  const r = await check("555");
  assert.equal(r.situacao, "com_debitos");
  assert.equal(r.saldo_exigivel, 300);
  assert.equal(r.saldo_a_vencer, 100);
});

test("crédito sem saldo (pago integral) não conta mesmo sem status quitado", async () => {
  // Estado de borda: status ainda 'divida_ativa' mas valor_pago == valor_lancado.
  // O filtro de saldo (valor_lancado > valor_pago) é quem exclui — não o status.
  await seedCredit("333", "DA-2", 400, 400, "divida_ativa");
  const r = await check("333");
  assert.equal(r.situacao, "regular");
  assert.equal(r.debts.length, 0);
});
