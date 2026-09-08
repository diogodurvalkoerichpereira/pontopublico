/**
 * Sprint 9 — importações em lote: teste de COMPORTAMENTO (substitui validate-sprint9).
 *
 * Sobe o esquema real em PGlite e provoca os CHECKs e as unicidades das tabelas de
 * importação. Rede de conformidade (lint): a rota de importação lê XLSX de fato.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "./helpers/pglite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let db;
let tenantId;
const BATCH = "77777777-7777-4777-8777-777777777777";

before(async () => {
  db = await createTestDb();
  const t = await db.query(
    "select id from public.tenants where status='ativo' order by created_at,id limit 1",
  );
  tenantId = t.rows[0].id;
});
after(async () => {
  await db.close();
});

const insertBatch = (sha, status = "validando", fileType = "csv") =>
  db.query(
    `insert into public.payroll_import_batches
       (tenant_id,file_name,file_type,reference_month,status,total_rows,file_sha256)
     values ($1,'f.csv',$2,'2024-03-01',$3,10,$4)`,
    [tenantId, fileType, status, sha],
  );

const HEX64 = "a".repeat(64);

test("as tabelas de importação existem", async () => {
  const r = await db.query(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name = any($1)`,
    [
      [
        "payroll_import_batches",
        "payroll_import_rows",
        "payroll_monthly_variables",
      ],
    ],
  );
  assert.equal(r.rows.length, 3);
});

test("CHECK: file_sha256 precisa ser hex de 64 (integridade do arquivo)", async () => {
  await assert.rejects(insertBatch("nao-e-hash"), /file_sha256|check/i);
});

test("CHECK: status do lote é restrito ao workflow", async () => {
  await assert.rejects(insertBatch(HEX64, "estado_invalido"), /status|check/i);
});

test("CHECK: file_type só txt/csv/xlsx", async () => {
  await assert.rejects(
    insertBatch(HEX64, "validando", "pdf"),
    /file_type|check/i,
  );
});

test("UNIQUE: (batch_id,row_number) não se repete no lote", async () => {
  await db.query(
    `insert into public.payroll_import_batches
       (id,tenant_id,file_name,file_type,reference_month,status,total_rows,file_sha256)
     values ($1,$2,'f.csv','csv','2024-03-01','validando',2,$3)`,
    [BATCH, tenantId, HEX64],
  );
  const row = (n) =>
    db.query(
      `insert into public.payroll_import_rows
         (tenant_id,batch_id,row_number,raw_data,status)
       values ($1,$2,$3,'{}'::jsonb,'valida')`,
      [tenantId, BATCH, n],
    );
  await row(1);
  await assert.rejects(row(1), /unique|duplicate/i);
});

test("lint: a rota de importação lê XLSX de verdade (exceljs)", () => {
  const src = readFileSync(
    join(root, "src", "routes", "rh.importacoes.tsx"),
    "utf8",
  );
  assert.match(src, /import\("exceljs"\)/);
});
