/**
 * Sprint 20 — migração histórica: teste de COMPORTAMENTO (substitui validate-sprint20).
 *
 * PGlite executa os CHECKs e a unicidade das tabelas de staging/arquivo. Rede de
 * conformidade (lint): os guardas de aplicação — janela de 15 anos, obrigação de
 * reconciliar antes de fechar, isolamento archiveOnly — seguem no código.
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
const UID = "88888888-8888-4888-8888-888888888888";
const JOB = "99999999-9999-4999-8999-999999999999";

before(async () => {
  db = await createTestDb();
  const t = await db.query(
    "select id from public.tenants where status='ativo' order by created_at,id limit 1",
  );
  tenantId = t.rows[0].id;
  // created_by exige um profile (→ app_users).
  await db.query(
    "insert into public.app_users(id,email,password_hash,raw_user_meta_data) values($1,$2,'x','{}')",
    [UID, `${UID}@e.com`],
  );
  await db.query(
    "insert into public.profiles(id,full_name,email,cpf,matricula,setor) values($1,'M',$2,'','','')",
    [UID, `${UID}@e.com`],
  );
});
after(async () => {
  await db.close();
});

test("as tabelas de migração histórica existem", async () => {
  const r = await db.query(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name = any($1)`,
    [
      [
        "historical_migration_jobs",
        "historical_migration_rows",
        "historical_records",
      ],
    ],
  );
  assert.equal(r.rows.length, 3);
});

test("CHECK: status do job é restrito ao workflow", async () => {
  await assert.rejects(
    db.query(
      `insert into public.historical_migration_jobs
         (tenant_id,name,source_type,status,expected_rows,created_by)
       values ($1,'J','x','estado_invalido',0,$2)`,
      [tenantId, UID],
    ),
    /status|check/i,
  );
});

test("UNIQUE: (job_id,source_key) é idempotente no staging", async () => {
  await db.query(
    `insert into public.historical_migration_jobs
       (id,tenant_id,name,source_type,status,expected_rows,created_by)
     values ($1,$2,'J','x','staged',0,$3)`,
    [JOB, tenantId, UID],
  );
  const stage = () =>
    db.query(
      `insert into public.historical_migration_rows
         (job_id,tenant_id,source_key,reference_date,payload,row_status)
       values ($1,$2,'K-1','2020-01-01','{}'::jsonb,'valid')`,
      [JOB, tenantId],
    );
  await stage();
  await assert.rejects(stage(), /unique|duplicate/i);
});

test("lint: os guardas de aplicação seguem no código", () => {
  const src = [
    "src/lib/historical-migration.functions.ts",
    "supabase/migrations/20260818080000_sprint20_historical_migration.sql",
  ]
    .map((f) => readFileSync(join(root, f), "utf8"))
    .join("\n");
  assert.match(src, /fora_da_janela_de_15_anos/, "janela de 15 anos");
  assert.match(src, /Reconciliação obrigatória/, "gate de reconciliação");
  assert.match(src, /archiveOnly/, "isolamento de arquivo");
});
