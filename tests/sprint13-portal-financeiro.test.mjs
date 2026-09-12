/**
 * Sprint 13 — portal financeiro do servidor: teste de COMPORTAMENTO
 * (substitui o grep validate-sprint13.mjs).
 *
 * Duas redes. (1) COMPORTAMENTO no banco: sobe o esquema real em PGlite e provoca
 * os CHECKs de `employee_financial_publications` (document_type na whitelist e
 * document_sha256 hex de 64). (2) CATÁLOGO: a policy `employee_financial_self`
 * existe (auto-escopo do servidor à própria matrícula — PGlite roda como owner,
 * então aferimos a EXISTÊNCIA da policy, não a negação). Rede de conformidade
 * (lint): o módulo escopa por source_profile_id, só publica folha 'fechada' e
 * aplica a margem consignável de 35%.
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
let cycleId;
let linkId;

const PERSON = "13000000-0000-4000-8000-000000000013";
const HEX64 = "b".repeat(64);

/** Insere uma publicação financeira válida por construção; `over` sobrescreve. */
function insertPublication(over = {}) {
  const v = {
    document_type: "contracheque",
    document_sha256: HEX64,
    ...over,
  };
  return db.query(
    `insert into public.employee_financial_publications
       (tenant_id,payroll_cycle_id,employment_link_id,document_type,reference_month,
        payload,document_sha256,verification_code)
     values ($1,$2,$3,$4,'2024-03-01','{}'::jsonb,$5,'ABC123')`,
    [tenantId, cycleId, linkId, v.document_type, v.document_sha256],
  );
}

before(async () => {
  db = await createTestDb();
  const t = await db.query(
    "select id from public.tenants where status='ativo' order by created_at,id limit 1",
  );
  tenantId = t.rows[0].id;
  await db.query(
    "insert into public.persons(id,full_name,personal_email) values($1,'P','p@e.com')",
    [PERSON],
  );
  await db.query(
    `insert into public.employment_links(tenant_id,person_id,source_profile_id,registration_number,status)
     values($1,$2,null,'M13','rascunho')`,
    [tenantId, PERSON],
  );
  linkId = (
    await db.query(
      "select id from public.employment_links where registration_number='M13' and tenant_id=$1",
      [tenantId],
    )
  ).rows[0].id;
  cycleId = (
    await db.query(
      `insert into public.payroll_cycles(tenant_id,reference_month,cycle_type,status)
       values($1,'2024-03-01','mensal','fechada') returning id`,
      [tenantId],
    )
  ).rows[0].id;
});

after(async () => {
  await db.close();
});

test("a tabela de publicações financeiras existe", async () => {
  const r = await db.query(
    `select 1 from information_schema.tables
     where table_schema='public' and table_name='employee_financial_publications'`,
  );
  assert.equal(r.rows.length, 1);
});

test("CHECK: document_type restrito à whitelist ('xpto' recusado)", async () => {
  await assert.rejects(
    insertPublication({ document_type: "xpto" }),
    /document_type|check/i,
  );
});

test("CHECK: document_sha256 precisa ser hex de 64", async () => {
  await assert.rejects(
    insertPublication({ document_sha256: "nothex" }),
    /document_sha256|check/i,
  );
});

test("uma publicação válida é aceita", async () => {
  await insertPublication();
  const r = await db.query(
    "select 1 from public.employee_financial_publications where employment_link_id=$1",
    [linkId],
  );
  assert.equal(r.rows.length, 1);
});

test("catálogo: a policy de auto-escopo employee_financial_self existe", async () => {
  const r = await db.query(
    `select 1 from pg_policies
     where tablename='employee_financial_publications'
       and policyname='employee_financial_self'`,
  );
  assert.equal(r.rows.length, 1);
});

test("lint: o módulo escopa por source_profile_id, folha 'fechada' e margem 35%", () => {
  const src = readFileSync(
    join(root, "src", "lib", "employee-finance.functions.ts"),
    "utf8",
  );
  assert.match(src, /source_profile_id=\$1/);
  assert.match(src, /status='fechada'/);
  assert.match(src, /\* 0\.35/);
});
