/**
 * Sprint 16 — data mart privado: teste de COMPORTAMENTO
 * (substitui o grep validate-sprint16.mjs).
 *
 * Duas redes. (1) COMPORTAMENTO no banco: sobe o esquema real em PGlite e afere o
 * schema `analytics` e suas fatos/etl; provoca o CHECK de `etl_runs.status`; e a
 * guarda forte — `analytics` é privado, `has_schema_privilege('authenticated',
 * 'analytics','USAGE')` é FALSE (só o service_role tem acesso). (2) CONFORMIDADE
 * (lint): o módulo reconcilia origem e mart.
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

const USER = "16000000-0000-4000-8000-000000000016";

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

test("o schema analytics existe", async () => {
  const r = await db.query(
    "select 1 from information_schema.schemata where schema_name='analytics'",
  );
  assert.equal(r.rows.length, 1);
});

test("as tabelas do data mart existem em analytics", async () => {
  const r = await db.query(
    `select table_name from information_schema.tables
     where table_schema='analytics' and table_name = any($1)`,
    [["fact_payroll", "fact_movement", "etl_runs"]],
  );
  assert.equal(r.rows.length, 3);
});

test("CHECK: etl_runs.status restrito à whitelist", async () => {
  await assert.rejects(
    db.query(
      `insert into analytics.etl_runs(tenant_id,status,created_by)
       values($1,'estado_invalido',$2)`,
      [tenantId, USER],
    ),
    /status|check/i,
  );
  // Sanidade: um status válido é aceito (a rejeição acima é do CHECK, não de coluna).
  await db.query(
    `insert into analytics.etl_runs(tenant_id,status,created_by) values($1,'running',$2)`,
    [tenantId, USER],
  );
});

test("guarda: analytics é privado — authenticated NÃO tem USAGE", async () => {
  const r = await db.query(
    "select has_schema_privilege('authenticated','analytics','USAGE') as g",
  );
  assert.equal(r.rows[0].g, false);
});

test("lint: o módulo reconcilia origem e mart", () => {
  const src = readFileSync(
    join(root, "src", "lib", "data-mart.functions.ts"),
    "utf8",
  );
  assert.match(src, /reconciled/);
});
