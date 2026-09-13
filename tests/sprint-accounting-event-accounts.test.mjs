/**
 * O2-06b (Onda 2) — roteiros contábeis configuráveis (accounting_event_accounts):
 * COMPORTAMENTO.
 *
 * saveAccountingEventAccount grava o par débito/crédito do evento e, gravado de
 * novo, ATUALIZA (upsert por ente/evento — um roteiro por evento); evento fora da
 * lista é recusado. getAccountingEventAccounts devolve todos os eventos
 * contabilizáveis, marcando os configurados e os ainda sem roteiro.
 *
 * Mutação: trocar o upsert por "do nothing" deixa o segundo save sem efeito —
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

const dir = mkdtempSync(join(tmpdir(), "acc-events-test-"));

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
const save = (event_code, debit_account, credit_account) =>
  fn.saveAccountingEventAccount({
    data: { tenant_id: tenantId, event_code, debit_account, credit_account },
    context: ctx(),
  });
const list = () =>
  fn.getAccountingEventAccounts({
    data: { tenant_id: tenantId },
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
  Object.assign(fn, await bundle("src/lib/accounting.functions.ts", "acc.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("lista todos os eventos; grava e atualiza o roteiro (um por evento); recusa evento desconhecido", async () => {
  const antes = await list();
  assert.equal(antes.roteiros.length, 7); // 4 do O2-06 + 3 da baixa de bem (O3-11c)
  assert.ok(antes.roteiros.every((r) => r.configurado === false));
  assert.equal(antes.canManage, true);

  await save("baixa_bem_alienacao", "1.1.1.1", "4.6.1");
  const depois = await list();
  const alienacao = depois.roteiros.find(
    (r) => r.event_code === "baixa_bem_alienacao",
  );
  assert.deepEqual(alienacao, {
    event_code: "baixa_bem_alienacao",
    debit_account: "1.1.1.1",
    credit_account: "4.6.1",
    configurado: true,
  });
  assert.equal(depois.roteiros.filter((r) => r.configurado).length, 1);

  // Gravar de novo atualiza as contas (um roteiro por evento), não duplica.
  await save("baixa_bem_alienacao", "1.1.1.2", "4.6.2");
  const atualizado = (await list()).roteiros.find(
    (r) => r.event_code === "baixa_bem_alienacao",
  );
  assert.equal(atualizado.debit_account, "1.1.1.2");
  assert.equal(atualizado.credit_account, "4.6.2");
  const linhas = (
    await db.query(
      "select count(*)::int as n from public.accounting_event_accounts where tenant_id=$1",
      [tenantId],
    )
  ).rows[0].n;
  assert.equal(linhas, 1);

  // Evento fora da lista e conta fora do padrão são recusados na validação.
  await assert.rejects(save("evento_inexistente", "1.1", "2.1"));
  await assert.rejects(save("empenho", "conta-x", "2.1"));
});
