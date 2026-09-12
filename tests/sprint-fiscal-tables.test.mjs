/**
 * O1-01 — tabelas fiscais versionadas no banco: teste de COMPORTAMENTO.
 *
 * Duas redes. (1) COMPORTAMENTO no banco (PGlite com o esquema real): o seed
 * INSS_FEDERAL/IRRF_FEDERAL existe, é nacional (tenant nulo) e está `publicada`;
 * o trigger de não-sobreposição recusa duas vigências publicadas que se cruzam e
 * aceita uma que só começa quando a anterior termina; a versão deve pertencer à
 * mesma entidade da tabela. (2) COMPORTAMENTO do loader: empacota o
 * `loadFiscalTables` real com `db.server` delegando à mesma PGlite, e afere que
 * ele devolve a versão vigente na competência com o checksum recomputado que
 * confere — e que um checksum adulterado no banco faz o loader LANÇAR.
 *
 * Mutação: apagar o seed, ou trocar um byte do checksum semeado, derruba o teste.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createTestDb } from "./helpers/pglite.mjs";

let db;
let loadFiscalTables;

const dir = mkdtempSync(join(tmpdir(), "fiscal-tables-test-"));

before(async () => {
  db = await createTestDb();

  // Stub de db.server: `query(text, params)` delega à MESMA PGlite e devolve
  // `rows` (a assinatura real de db.server), para exercitar o loader de verdade.
  const dbStub = join(dir, "db.mjs");
  writeFileSync(
    dbStub,
    `export async function query(text, params) {
       const r = await globalThis.__fiscalDb.query(text, params ?? []);
       return r.rows;
     }`,
  );
  const bundle = join(dir, "fiscal-tables.mjs");
  await build({
    entryPoints: ["src/lib/fiscal-tables.server.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundle,
    logLevel: "silent",
    external: ["node:*"],
    plugins: [
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
  });
  globalThis.__fiscalDb = db;
  ({ loadFiscalTables } = await import(bundle));
});

after(async () => {
  await db.close();
  delete globalThis.__fiscalDb;
  rmSync(dir, { recursive: true, force: true });
});

test("o seed nacional INSS/IRRF existe e esta publicado", async () => {
  const r = await db.query(
    `select ft.code, v.status, v.tenant_id
     from public.fiscal_table_versions v
     join public.fiscal_tables ft on ft.id = v.fiscal_table_id
     where ft.code in ('INSS_FEDERAL', 'IRRF_FEDERAL')
     order by ft.code`,
  );
  assert.equal(r.rows.length, 2);
  for (const row of r.rows) {
    assert.equal(row.status, "publicada");
    assert.equal(row.tenant_id, null); // nacional
  }
});

test("o loader devolve a versao vigente com checksum que confere", async () => {
  const anyTenant = await db.query(
    "select id from public.tenants order by created_at, id limit 1",
  );
  const tenantId = anyTenant.rows[0].id;
  const tables = await loadFiscalTables(tenantId, "2025-06-01");

  const inss = tables.get("INSS_FEDERAL");
  assert.ok(inss, "INSS_FEDERAL nao carregada");
  assert.equal(inss.versionId, "f1541b1e-0000-4000-8000-000000000011");
  assert.equal(inss.brackets.length, 4);
  assert.ok(tables.get("IRRF_FEDERAL"), "IRRF_FEDERAL nao carregada");
});

test("competencia anterior a vigencia nao carrega a tabela", async () => {
  const anyTenant = await db.query(
    "select id from public.tenants order by created_at, id limit 1",
  );
  const tables = await loadFiscalTables(anyTenant.rows[0].id, "2024-12-31");
  assert.equal(tables.size, 0); // vigencia comeca em 2025-01-01
});

test("checksum adulterado no banco faz o loader lancar", async () => {
  const anyTenant = await db.query(
    "select id from public.tenants order by created_at, id limit 1",
  );
  // Adultera o checksum (mantendo o formato 64-hex do CHECK) e restaura depois.
  const original =
    "8a8683b1fe89704ed2b2e3aefcdc1bf7df282bf0da566f28be7f3640de785ac4";
  const forjado =
    "0000000000000000000000000000000000000000000000000000000000000000";
  await db.query(
    "update public.fiscal_table_versions set checksum = $1 where id = 'f1541b1e-0000-4000-8000-000000000011'",
    [forjado],
  );
  await assert.rejects(
    () => loadFiscalTables(anyTenant.rows[0].id, "2025-06-01"),
    /Checksum de tabela fiscal divergente: INSS_FEDERAL/,
  );
  await db.query(
    "update public.fiscal_table_versions set checksum = $1 where id = 'f1541b1e-0000-4000-8000-000000000011'",
    [original],
  );
});

test("o trigger recusa duas vigencias publicadas que se cruzam", async () => {
  const tid = "f1541b1e-0000-4000-8000-000000000001"; // INSS_FEDERAL
  // O seed ja e uma vigencia publicada aberta (valid_to nulo) desde 2025-01-01.
  await assert.rejects(
    () =>
      db.query(
        `insert into public.fiscal_table_versions
           (tenant_id, fiscal_table_id, version_number, valid_from, status, brackets, checksum)
         values (null, $1, 2, '2025-06-01', 'publicada', '[]'::jsonb, $2)`,
        [
          tid,
          "1111111111111111111111111111111111111111111111111111111111111111",
        ],
      ),
    /se sobrepoe/,
  );
});

test("o trigger aceita vigencia que so comeca apos a anterior fechar", async () => {
  const tid = "f1541b1e-0000-4000-8000-000000000002"; // IRRF_FEDERAL
  // Fecha a vigencia do seed em 2025-12-31 e abre a proxima em 2026-01-01.
  await db.query(
    `update public.fiscal_table_versions set valid_to = '2025-12-31'
     where id = 'f1541b1e-0000-4000-8000-000000000012'`,
  );
  await db.query(
    `insert into public.fiscal_table_versions
       (tenant_id, fiscal_table_id, version_number, valid_from, status, brackets, checksum)
     values (null, $1, 2, '2026-01-01', 'publicada', '[]'::jsonb, $2)`,
    [tid, "2222222222222222222222222222222222222222222222222222222222222222"],
  );
  const r = await db.query(
    `select count(*)::int as n from public.fiscal_table_versions
     where fiscal_table_id = $1 and status = 'publicada'`,
    [tid],
  );
  assert.equal(r.rows[0].n, 2);
});
