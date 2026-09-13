/**
 * O2-05 (Onda 2) — razão contábil em partidas dobradas: COMPORTAMENTO.
 *
 * postAccountingEntry escritura um lançamento balanceado (Σdébito = Σcrédito) e o
 * recusa se desbalanceado; getBalancete devolve o saldo por conta. Confere a
 * dupla partida e o balancete.
 *
 * Mutação: remover a checagem de balanceamento (aceita desbalanceado) derruba.
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

const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));

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
  Object.assign(fn, await bundle("src/lib/accounting.functions.ts", "acc.mjs"));
  Object.assign(
    fn,
    await bundle("src/lib/accounting-read.functions.ts", "accr.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("lançamento balanceado é escriturado; o balancete bate", async () => {
  // Empenho: D 6.2.2.1.1 (credito empenhado a liquidar) C 5.2.2.1.1 ... (controle).
  await fn.postAccountingEntry({
    data: {
      tenant_id: tenantId,
      exercicio: 2026,
      data_lancamento: "2026-03-15",
      historico: "Empenho de material",
      lines: [
        { conta: "6.2.2.1.1", lado: "D", valor: 1000 },
        { conta: "5.2.2.1.1", lado: "C", valor: 1000 },
      ],
    },
    context: ctx(),
  });
  const bal = await fn.getBalancete({
    data: { tenant_id: tenantId, exercicio: 2026 },
    context: ctx(),
  });
  const byConta = new Map(bal.contas.map((b) => [b.conta, b]));
  assert.equal(Number(byConta.get("6.2.2.1.1").saldo), 1000);
  assert.equal(Number(byConta.get("5.2.2.1.1").saldo), -1000);
  // O balancete inteiro soma zero (partidas dobradas).
  const somaSaldos = bal.contas.reduce((s, b) => s + Number(b.saldo), 0);
  assert.equal(somaSaldos, 0);
  // Balancete de verificação: total de débitos = total de créditos → confere.
  assert.equal(bal.totais.debito, 1000);
  assert.equal(bal.totais.credito, 1000);
  assert.equal(bal.conferido, true);
});

test("lançamento desbalanceado é recusado", async () => {
  await assert.rejects(
    fn.postAccountingEntry({
      data: {
        tenant_id: tenantId,
        exercicio: 2026,
        data_lancamento: "2026-03-16",
        historico: "Desbalanceado",
        lines: [
          { conta: "1.1.1.1.1", lado: "D", valor: 1000 },
          { conta: "2.1.1.1.1", lado: "C", valor: 900 },
        ],
      },
      context: ctx(),
    }),
    /desbalanceado/,
  );
});

test("lançamento com débito e crédito múltiplos que se igualam é aceito", async () => {
  const r = await fn.postAccountingEntry({
    data: {
      tenant_id: tenantId,
      exercicio: 2026,
      data_lancamento: "2026-03-17",
      historico: "Rateio",
      lines: [
        { conta: "3.1.1.1.1", lado: "D", valor: 700 },
        { conta: "3.1.1.1.2", lado: "D", valor: 300 },
        { conta: "1.1.1.1.1", lado: "C", valor: 1000 },
      ],
    },
    context: ctx(),
  });
  assert.equal(r.valor, 1000);
});
