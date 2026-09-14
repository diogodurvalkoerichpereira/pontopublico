/**
 * O2-18 (Onda 2) — balanço patrimonial + DVP (PCASP): COMPORTAMENTO.
 *
 * getEquityStatement classifica o razão pela classe PCASP (1 Ativo, 2 Passivo,
 * 3 VPD, 4 VPA), inverte o sinal das contas credoras e apura Ativo, Passivo, PL,
 * VPA, VPD e o resultado patrimonial (VPA − VPD). Confere a classificação, o sinal
 * e a coerência PL = resultado quando o PL inicial é zero.
 *
 * Mutação: inverter para VPD − VPA no resultado_patrimonial derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "equity-statement-test-"));

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

// Lança um fato balanceado (débito numa conta, crédito noutra) no exercício dado.
async function post(historico, valor, contaD, contaC, exercicio = 2026) {
  const entryId = randomUUID();
  await db.query(
    `insert into public.accounting_entries
       (id, tenant_id, exercicio, data_lancamento, historico, valor)
     values ($1,$2,$5::int,make_date($5::int,3,1),$3,$4)`,
    [entryId, tenantId, historico, valor, exercicio],
  );
  await db.query(
    `insert into public.accounting_entry_lines (id, tenant_id, entry_id, conta, lado, valor)
     values ($1,$2,$3,$4,'D',$5), ($6,$2,$3,$7,'C',$5)`,
    [randomUUID(), tenantId, entryId, contaD, valor, randomUUID(), contaC],
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
    await bundle("src/lib/equity-statement.functions.ts", "es.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("separa o PL (2.3) do passivo, acumula o patrimonial e fecha a equação", async () => {
  // --- Exercício ANTERIOR (2025): sobra patrimônio escriturado no PL (2.3).
  // Dotação inicial: D caixa (1) 2000 / C patrimônio social (2.3) 2000.
  await post("Patrimonio inicial", 2000, "1.1.1", "2.3.1", 2025);

  // --- Exercício de referência (2026).
  // Arrecada receita: D caixa (1) 1000 / C VPA (4) 1000.
  await post("Arrecadacao", 1000, "1.1.1", "4.1.1");
  // Paga despesa: D VPD (3) 400 / C caixa (1) 400.
  await post("Despesa paga", 400, "3.1.1", "1.1.1");
  // Assume obrigação: D imobilizado (1) 500 / C fornecedor passivo (2.1) 500.
  await post("Aquisicao a prazo", 500, "1.2.3", "2.1.1");

  const r = await fn.getEquityStatement({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });

  // Ativo ACUMULADO: 2000 (2025) + 1000 − 400 + 500 = 3100. Sem acumular, o bem
  // e o caixa de 2025 sumiriam do balanço de 2026.
  assert.equal(r.ativo, 3100);
  // Passivo exigível: só 2.1 (o grupo 2.3 é patrimônio líquido, não passivo).
  assert.equal(r.passivo, 500);
  // PL escriturado em 2.3, acumulado dos exercícios anteriores.
  assert.equal(r.patrimonio_liquido_escriturado, 2000);
  assert.equal(r.vpa, 1000);
  assert.equal(r.vpd, 400);
  assert.equal(r.resultado_patrimonial, 600);
  // PL do balanço = escriturado + resultado do período (ainda não transposto).
  assert.equal(r.patrimonio_liquido, 2600);
  // A equação patrimonial fecha: 3100 = 500 + 2600.
  assert.equal(r.conferido, true);
  // E o PL NÃO é mais idêntico ao resultado do período (era tautologia).
  assert.notEqual(r.patrimonio_liquido, r.resultado_patrimonial);
});

test("o exercício anterior enxerga só o que foi escriturado até ele", async () => {
  const r2025 = await fn.getEquityStatement({
    data: { tenant_id: tenantId, exercicio: 2025 },
    context: ctx(),
  });
  assert.equal(r2025.ativo, 2000);
  assert.equal(r2025.passivo, 0);
  assert.equal(r2025.patrimonio_liquido_escriturado, 2000);
  // Sem fato de resultado em 2025, o resultado do período é zero.
  assert.equal(r2025.resultado_patrimonial, 0);
  assert.equal(r2025.patrimonio_liquido, 2000);
  assert.equal(r2025.conferido, true);
});
