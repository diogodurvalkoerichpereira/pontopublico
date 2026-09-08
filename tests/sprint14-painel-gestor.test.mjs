/**
 * Sprint 14 — painel do gestor: teste de COMPORTAMENTO
 * (substitui o grep validate-sprint14.mjs).
 *
 * Duas redes. (1) COMPORTAMENTO no banco: sobe o esquema real em PGlite e provoca
 * o CHECK de `manager_kpi_snapshots.source_checksum` (hex de 64) e a unicidade
 * `(tenant_id,reference_month,dimensions)`. (2) CONFORMIDADE (lint): o módulo
 * reconcilia bruto-descontos=líquido e calcula idade_media.
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

const HEX64 = "c".repeat(64);

/** Insere um snapshot de KPIs válido por construção; `over` sobrescreve. */
function insertSnapshot(over = {}) {
  const v = {
    reference_month: "2024-03-01",
    dimensions: "{}",
    source_checksum: HEX64,
    ...over,
  };
  return db.query(
    `insert into public.manager_kpi_snapshots
       (tenant_id,reference_month,dimensions,metrics,source_checksum)
     values ($1,$2,$3::jsonb,'{}'::jsonb,$4)`,
    [tenantId, v.reference_month, v.dimensions, v.source_checksum],
  );
}

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

test("a tabela de snapshots de KPI existe", async () => {
  const r = await db.query(
    `select 1 from information_schema.tables
     where table_schema='public' and table_name='manager_kpi_snapshots'`,
  );
  assert.equal(r.rows.length, 1);
});

test("CHECK: source_checksum precisa ser hex de 64", async () => {
  await assert.rejects(
    insertSnapshot({ source_checksum: "naoehash" }),
    /source_checksum|check/i,
  );
});

test("UNIQUE: (tenant_id,reference_month,dimensions) não se repete", async () => {
  await insertSnapshot({ reference_month: "2024-04-01" });
  await assert.rejects(
    insertSnapshot({ reference_month: "2024-04-01" }),
    /unique|duplicate/i,
  );
});

test("lint: o módulo reconcilia e calcula idade média", () => {
  const src = readFileSync(
    join(root, "src", "lib", "manager-dashboard.functions.ts"),
    "utf8",
  );
  assert.match(src, /reconciled/);
  assert.match(src, /idade_media/);
});
