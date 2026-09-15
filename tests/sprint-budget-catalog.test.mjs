/**
 * O2-35 — catálogo de classificação orçamentária: COMPORTAMENTO.
 *
 * O catálogo tem duas camadas: as linhas com `tenant_id` nulo são o padrão
 * nacional que acompanha o sistema; as do ente são acréscimos dele. Confere que
 * o padrão chega a qualquer ente, que o acréscimo do ente NÃO vaza para outro, e
 * que o ente pode dar o seu próprio nome a um código do padrão.
 *
 * Mutação: tirar o filtro de tenant do `select` faz o código de um ente aparecer
 * no outro e derruba.
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
let outroTenantId;
let userId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "catalog-test-"));

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
const ler = (tid, tipo) =>
  fn.getBudgetCatalog({
    data: { tenant_id: tid, tipo },
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
  outroTenantId = randomUUID();
  await db.query(
    "insert into public.tenants (id, codigo, nome) values ($1,$2,$3)",
    [outroTenantId, `t-${outroTenantId.slice(0, 8)}`, "Outro ente"],
  );
  userId = randomUUID();
  await db.query(
    "insert into public.app_users (id, email, password_hash) values ($1,$2,'x')",
    [userId, `a-${userId}@t.local`],
  );
  await db.query("insert into public.profiles (id) values ($1)", [userId]);
  Object.assign(
    fn,
    await bundle("src/lib/budget-catalog.functions.ts", "cat.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("o catalogo padrao chega ao ente, com as classificacoes oficiais", async () => {
  const funcoes = await ler(tenantId, "funcao");
  const codigos = funcoes.codigos.map((c) => c.codigo);
  // Portaria MOG 42/1999: 28 funções + reserva de contingência.
  assert.ok(codigos.includes("04"), "Administração");
  assert.ok(codigos.includes("10"), "Saúde");
  assert.ok(codigos.includes("12"), "Educação");
  assert.ok(codigos.includes("28"), "Encargos Especiais");
  assert.ok(funcoes.codigos.length >= 29, "as 28 funções + reserva");
  assert.ok(
    funcoes.codigos.every((c) => c.proprio === false),
    "tudo do padrão nacional",
  );

  const fontes = await ler(tenantId, "fonte_recurso");
  const fcodigos = fontes.codigos.map((c) => c.codigo);
  assert.ok(fcodigos.includes("500"), "Recursos não vinculados de impostos");
  assert.ok(fcodigos.includes("540"), "FUNDEB");
  assert.ok(fcodigos.includes("600"), "SUS fundo a fundo");

  const elementos = await ler(tenantId, "natureza_elemento");
  const ecodigos = elementos.codigos.map((c) => c.codigo);
  assert.ok(ecodigos.includes("11"), "Vencimentos e vantagens fixas");
  assert.ok(ecodigos.includes("30"), "Material de consumo");
  assert.ok(ecodigos.includes("52"), "Equipamentos e material permanente");
});

test("filtrar por tipo devolve so aquele nivel", async () => {
  const grupos = await ler(tenantId, "natureza_grupo");
  assert.ok(grupos.codigos.length > 0);
  assert.ok(
    grupos.codigos.every((c) => c.tipo === "natureza_grupo"),
    "nenhum código de outro nível vaza para a lista",
  );
});

test("codigo do ente nao vaza para outro ente", async () => {
  // A fonte que o TCE do ente exige é dele; o ente vizinho não pode vê-la.
  await fn.saveBudgetCatalogCode({
    data: {
      tenant_id: tenantId,
      tipo: "fonte_recurso",
      codigo: "9901",
      nome: "Fonte exigida pelo TCE deste ente",
    },
    context: ctx(),
  });

  const meu = await ler(tenantId, "fonte_recurso");
  const minha = meu.codigos.find((c) => c.codigo === "9901");
  assert.ok(minha, "o ente vê a fonte que cadastrou");
  assert.equal(minha.proprio, true, "marcada como do ente");

  const vizinho = await ler(outroTenantId, "fonte_recurso");
  assert.equal(
    vizinho.codigos.find((c) => c.codigo === "9901"),
    undefined,
    "o ente vizinho NÃO vê a fonte do outro",
  );
  // Mas continua vendo o padrão nacional.
  assert.ok(vizinho.codigos.some((c) => c.codigo === "500"));
});

test("regravar o mesmo codigo do ente atualiza o nome, nao duplica", async () => {
  await fn.saveBudgetCatalogCode({
    data: {
      tenant_id: tenantId,
      tipo: "fonte_recurso",
      codigo: "9901",
      nome: "Nome corrigido",
    },
    context: ctx(),
  });
  const r = await ler(tenantId, "fonte_recurso");
  const achadas = r.codigos.filter((c) => c.codigo === "9901");
  assert.equal(achadas.length, 1, "uma linha só");
  assert.equal(achadas[0].nome, "Nome corrigido");
});

test("o ente pode dar o seu nome a um codigo do padrao", async () => {
  // O padrão nacional não é editável; o ente cadastra o dele, e a tela faz o
  // próprio prevalecer.
  await fn.saveBudgetCatalogCode({
    data: {
      tenant_id: tenantId,
      tipo: "fonte_recurso",
      codigo: "500",
      nome: "Recursos Ordinarios (nome local)",
    },
    context: ctx(),
  });
  const r = await ler(tenantId, "fonte_recurso");
  const cincoCentos = r.codigos.filter((c) => c.codigo === "500");
  assert.equal(cincoCentos.length, 2, "o padrão e o do ente coexistem");
  assert.ok(
    cincoCentos.some((c) => c.proprio && c.nome.includes("nome local")),
    "o do ente está marcado como próprio",
  );
});
