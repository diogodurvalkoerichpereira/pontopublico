/**
 * O3-08 (Onda 3) — itens do contrato (Lei 14.133): COMPORTAMENTO.
 *
 * addContractItem adiciona linhas (valor = quantidade × preço) com numeração
 * sequencial; a soma dos itens não pode exceder o valor do contrato. Confere o
 * cálculo do valor, a numeração e o teto.
 *
 * Mutação: ignorar a soma dos itens já lançados no teto derruba.
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

const dir = mkdtempSync(join(tmpdir(), "contract-items-test-"));

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
  `const PERMS = ["contracts.read","contracts.manage"];
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

async function seedContract(valorTotal) {
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_contracts
       (id, tenant_id, numero, ano, fornecedor, fornecedor_documento, objeto,
        modalidade, valor_total, vigencia_inicio, vigencia_fim)
     values ($1,$2,$3,2026,'Fornecedor','000','Objeto','pregao',$4,
        '2026-01-01','2026-12-31')`,
    [id, tenantId, `CT-${id.slice(0, 8)}`, valorTotal],
  );
  return id;
}

const addItem = (contractId, qtd, preco) =>
  fn.addContractItem({
    data: {
      tenant_id: tenantId,
      contract_id: contractId,
      descricao: "Item",
      unidade: "un",
      quantidade: qtd,
      preco_unitario: preco,
    },
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
    await bundle("src/lib/contract-items.functions.ts", "i.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("valor = qtd × preço, numeração sequencial, soma não passa do contrato", async () => {
  const c = await seedContract(1000);
  const i1 = await addItem(c, 10, 50); // 500
  assert.equal(i1.numero, 1);
  assert.equal(i1.valor_total, 500);
  const i2 = await addItem(c, 5, 100); // 500 → soma 1000 (exato)
  assert.equal(i2.numero, 2);
  assert.equal(i2.valor_total, 500);
  // +0.01 estoura o teto do contrato.
  await assert.rejects(addItem(c, 1, 0.01), /valor do contrato/);

  const { items } = await fn.getContractItems({
    data: { tenant_id: tenantId, contract_id: c },
    context: ctx(),
  });
  assert.equal(items.length, 2);
});

test("item fracionado calcula e arredonda o valor da linha", async () => {
  const c = await seedContract(1000);
  const i = await addItem(c, 3, 33.33); // 99.99
  assert.equal(i.valor_total, 99.99);
});

// --- O3-14: cancelamento do item ------------------------------------------
//
// A soma dos itens é limitada pelo valor do contrato. Sem cancelamento, um item
// lançado errado consumia essa cota para sempre.

const cancelaItem = (item_id, motivo = "Item lancado em duplicidade") =>
  fn.cancelContractItem({
    data: { tenant_id: tenantId, item_id, motivo },
    context: ctx(),
  });

test("item cancelado devolve a cota do valor do contrato", async () => {
  const c = await seedContract(10000);
  const errado = await fn.addContractItem({
    data: {
      tenant_id: tenantId,
      contract_id: c,
      descricao: "Item errado",
      unidade: "un",
      quantidade: 1,
      preco_unitario: 10000,
    },
    context: ctx(),
  });
  // Com o errado de pé, o contrato está lotado.
  await assert.rejects(
    fn.addContractItem({
      data: {
        tenant_id: tenantId,
        contract_id: c,
        descricao: "Item certo",
        unidade: "un",
        quantidade: 1,
        preco_unitario: 500,
      },
      context: ctx(),
    }),
    /excederia o valor do contrato/,
  );

  await cancelaItem(errado.id);
  const certo = await fn.addContractItem({
    data: {
      tenant_id: tenantId,
      contract_id: c,
      descricao: "Item certo",
      unidade: "un",
      quantidade: 1,
      preco_unitario: 9000,
    },
    context: ctx(),
  });
  assert.ok(certo.id);

  // O cancelado continua na lista, marcado: o histórico faz parte do processo.
  const lista = await fn.getContractItems({
    data: { tenant_id: tenantId, contract_id: c },
    context: ctx(),
  });
  const cancelado = lista.items.find((i) => i.id === errado.id);
  assert.equal(cancelado.status, "cancelado");
  assert.equal(cancelado.motivo_cancelamento, "Item lancado em duplicidade");
});

test("cancelar item duas vezes e recusado", async () => {
  const c = await seedContract(5000);
  const item = await fn.addContractItem({
    data: {
      tenant_id: tenantId,
      contract_id: c,
      descricao: "Item",
      unidade: "un",
      quantidade: 1,
      preco_unitario: 100,
    },
    context: ctx(),
  });
  await cancelaItem(item.id);
  await assert.rejects(cancelaItem(item.id), /já está cancelado/);
});
