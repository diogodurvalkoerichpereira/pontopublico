/**
 * O1-02a — write-path das tabelas fiscais do ENTE: teste de COMPORTAMENTO.
 *
 * Sobe o esquema real em PGlite e EXECUTA os handlers de `fiscal-tables.functions.ts`
 * (createServerFn/db.server/tenant-access/audit stubados; a math de checksum e o
 * trigger do banco são reais). Prova o elo que faltava para o RPPS: um ente cria e
 * publica a sua tabela; o loader passa a devolvê-la sobrepondo a nacional; e o
 * avaliador do ADR 0003 calcula o progressivo do ente com checksum na memória.
 *
 * Também: versão publicada imutável, faixas inválidas rejeitadas, e o trigger de
 * não-sobreposição de vigências publicadas. Mutação: quebrar a numeração de versão,
 * a imutabilidade ou o checksum derruba o teste.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createTestDb } from "./helpers/pglite.mjs";

let db;
let tenantId;
let userId;
let saveFiscalTable;
let saveFiscalTableVersion;
let loadFiscalTables;
let evaluateFormulaAst;

const dir = mkdtempSync(join(tmpdir(), "fiscal-admin-test-"));

// Stub de db.server que delega à MESMA PGlite (query/queryOne/withTransaction).
const dbStub = join(dir, "db.mjs");
writeFileSync(
  dbStub,
  `export async function query(t, p) { const r = await globalThis.__db.query(t, p ?? []); return r.rows; }
   export async function queryOne(t, p) { const r = await globalThis.__db.query(t, p ?? []); return r.rows[0] ?? null; }
   export async function withTransaction(fn) {
     return fn({ query: async (t, p) => globalThis.__db.query(t, p ?? []) });
   }`,
);
// createServerFn: captura o handler; o resultado é chamável com { data, context }
// e roda o validator (zod) antes — cobre a validação de entrada.
const startStub = join(dir, "start.mjs");
writeFileSync(
  startStub,
  `export function createServerFn() {
     let validate = (x) => x;
     const b = {
       middleware() { return b; },
       validator(fn) { validate = fn; return b; },
       inputValidator(fn) { validate = fn; return b; },
       handler(fn) { return async ({ data, context }) => fn({ data: validate(data), context }); },
     };
     return b;
   }`,
);
const dataStub = join(dir, "data.mjs");
writeFileSync(dataStub, `export const requireAuth = {};`);
const taStub = join(dir, "ta.mjs");
writeFileSync(
  taStub,
  `export async function loadTenantAccess() {
     return { permissions: ["fiscal.read", "fiscal.manage"] };
   }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }`,
);
const auditStub = join(dir, "audit.mjs");
writeFileSync(
  auditStub,
  `export async function recordAudit() {}
   export async function recordAuditQ() {}`,
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

async function bundle(entry, name, plugins) {
  const out = join(dir, name);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
    external: ["node:*"],
    plugins,
  });
  return import(out);
}

before(async () => {
  db = await createTestDb();
  globalThis.__db = db;
  tenantId = (
    await db.query(
      "select id from public.tenants order by created_at, id limit 1",
    )
  ).rows[0].id;
  userId =
    (await db.query("select id from public.profiles order by id limit 1"))
      .rows[0]?.id ?? null;

  ({ saveFiscalTable, saveFiscalTableVersion } = await bundle(
    "src/lib/fiscal-tables.functions.ts",
    "fn.mjs",
    [stubPlugin()],
  ));
  // O loader delega ao mesmo __db (só db.server stubado).
  ({ loadFiscalTables } = await bundle(
    "src/lib/fiscal-tables.server.ts",
    "loader.mjs",
    [
      {
        name: "stub-db",
        setup(b) {
          b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({
            path: dbStub,
            external: true,
          }));
        },
      },
    ],
  ));
  ({ evaluateFormulaAst } = await bundle(
    "src/lib/payroll-formula.ts",
    "formula.mjs",
    [],
  ));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ userId });

test("o ente cria e publica uma tabela que sobrepoe a nacional no loader", async () => {
  // Mesmo codigo da nacional (INSS_FEDERAL), mas do ente e com faixas proprias.
  const { id: tableId } = await saveFiscalTable({
    data: {
      tenant_id: tenantId,
      code: "INSS_FEDERAL",
      name: "INSS do ente",
      status: "ativo",
    },
    context: ctx(),
  });
  const { id: versionId, versionNumber } = await saveFiscalTableVersion({
    data: {
      tenant_id: tenantId,
      fiscal_table_id: tableId,
      valid_from: "2025-01-01",
      status: "publicada",
      brackets: [
        { ate: 3000, aliquota: 0.1 },
        { ate: 999999999, aliquota: 0.14 },
      ],
    },
    context: ctx(),
  });
  assert.equal(versionNumber, 1);

  const tables = await loadFiscalTables(tenantId, "2025-06-01");
  const inss = tables.get("INSS_FEDERAL");
  assert.ok(inss, "INSS_FEDERAL nao carregada");
  assert.equal(inss.versionId, versionId, "o ente deve sobrepor a nacional");
  assert.equal(inss.brackets.length, 2); // as faixas do ente, nao as 4 nacionais
});

test("RPPS ponta a ponta: table_lookup do ente calcula progressivo com checksum", async () => {
  const { id: tableId } = await saveFiscalTable({
    data: {
      tenant_id: tenantId,
      code: "RPPS_ENTE",
      name: "RPPS do ente",
      status: "ativo",
    },
    context: ctx(),
  });
  const { id: versionId, checksum } = await saveFiscalTableVersion({
    data: {
      tenant_id: tenantId,
      fiscal_table_id: tableId,
      valid_from: "2025-01-01",
      status: "publicada",
      brackets: [
        { ate: 5000, aliquota: 0.11 },
        { ate: 999999999, aliquota: 0.14 },
      ],
    },
    context: ctx(),
  });

  const tables = await loadFiscalTables(tenantId, "2025-06-01");
  const evaluation = evaluateFormulaAst(
    {
      type: "table_lookup",
      table: "RPPS_ENTE",
      mode: "progressive",
      base: { type: "variable", name: "inss_base" },
    },
    { inss_base: 6000 },
    tables,
  );
  // 5000*0.11 + (6000-5000)*0.14 = 550 + 140 = 690
  assert.equal(evaluation.rawValue, 690);
  const step = evaluation.steps.find((s) => s.kind === "table_lookup");
  assert.equal(step.tableVersionId, versionId);
  assert.equal(step.tableChecksum, checksum);
});

test("versao publicada e imutavel", async () => {
  const { id: tableId } = await saveFiscalTable({
    data: {
      tenant_id: tenantId,
      code: "IMUT",
      name: "Imutavel",
      status: "ativo",
    },
    context: ctx(),
  });
  const { id: versionId } = await saveFiscalTableVersion({
    data: {
      tenant_id: tenantId,
      fiscal_table_id: tableId,
      valid_from: "2025-01-01",
      status: "publicada",
      brackets: [{ ate: 1000, aliquota: 0.1 }],
    },
    context: ctx(),
  });
  await assert.rejects(
    () =>
      saveFiscalTableVersion({
        data: {
          id: versionId,
          tenant_id: tenantId,
          fiscal_table_id: tableId,
          valid_from: "2025-02-01",
          status: "publicada",
          brackets: [{ ate: 2000, aliquota: 0.12 }],
        },
        context: ctx(),
      }),
    /imutável/,
  );
});

test("faixas invalidas sao rejeitadas na validacao", async () => {
  const { id: tableId } = await saveFiscalTable({
    data: {
      tenant_id: tenantId,
      code: "BADBR",
      name: "Faixas ruins",
      status: "ativo",
    },
    context: ctx(),
  });
  const base = {
    tenant_id: tenantId,
    fiscal_table_id: tableId,
    valid_from: "2025-01-01",
    status: "rascunho",
  };
  // aliquota > 1
  await assert.rejects(() =>
    saveFiscalTableVersion({
      data: { ...base, brackets: [{ ate: 1000, aliquota: 1.5 }] },
      context: ctx(),
    }),
  );
  // `ate` nao crescente
  await assert.rejects(() =>
    saveFiscalTableVersion({
      data: {
        ...base,
        brackets: [
          { ate: 2000, aliquota: 0.1 },
          { ate: 2000, aliquota: 0.12 },
        ],
      },
      context: ctx(),
    }),
  );
});

test("o trigger recusa duas vigencias publicadas sobrepostas do ente", async () => {
  const { id: tableId } = await saveFiscalTable({
    data: {
      tenant_id: tenantId,
      code: "OVL",
      name: "Sobreposicao",
      status: "ativo",
    },
    context: ctx(),
  });
  await saveFiscalTableVersion({
    data: {
      tenant_id: tenantId,
      fiscal_table_id: tableId,
      valid_from: "2025-01-01",
      status: "publicada",
      brackets: [{ ate: 1000, aliquota: 0.1 }],
    },
    context: ctx(),
  });
  await assert.rejects(
    () =>
      saveFiscalTableVersion({
        data: {
          tenant_id: tenantId,
          fiscal_table_id: tableId,
          valid_from: "2025-06-01",
          status: "publicada",
          brackets: [{ ate: 1000, aliquota: 0.12 }],
        },
        context: ctx(),
      }),
    /sobrepoe/,
  );
});
