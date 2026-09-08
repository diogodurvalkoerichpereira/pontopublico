/**
 * Sprint 8 — férias: teste de COMPORTAMENTO (substitui o grep validate-sprint8.mjs).
 *
 * Sobe o esquema real em PGlite e provoca as travas de verdade: os CHECKs das
 * tabelas e o trigger `trg_validate_vacation`. Um teste que executa o SQL — não
 * lê o arquivo como string. Removê-lo de qualquer migration faz um caso falhar.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/pglite.mjs";

let db;
let tenantId;

const TENANT = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";
const LINK = "44444444-4444-4444-8444-444444444444";
const POLICY = "55555555-5555-4555-8555-555555555555";
const PERIOD = "66666666-6666-4666-8666-666666666666";

/** Insere uma fração de férias válida por construção (amounts e payment_date ok). */
async function insertSchedule({ id, start, end, days }) {
  await db.query(
    `insert into public.vacation_schedules
       (id,tenant_id,accrual_period_id,start_date,end_date,days,base_amount,bonus_amount,total_amount,payment_date,memory)
     values ($1,$2,$3,$4,$5,$6,1000,333,1333,$7,'{}'::jsonb)`,
    [id, tenantId, PERIOD, start, end, days, "2020-01-01"],
  );
}

before(async () => {
  db = await createTestDb();
  // Reusa o ente semeado pela Sprint 1; se não houver, cria um.
  const t = await db.query(
    "select id from public.tenants where status='ativo' order by created_at,id limit 1",
  );
  tenantId = t.rows[0]?.id ?? TENANT;
  if (!t.rows.length)
    await db.query(
      "insert into public.tenants(id,codigo,nome,status) values($1,'T','T','ativo')",
      [TENANT],
    );
  // Cadeia mínima: pessoa → vínculo → política → período aquisitivo (30 dias).
  await db.query(
    "insert into public.persons(id,full_name,personal_email) values($1,'P','p@e.com')",
    [PERSON],
  );
  await db.query(
    `insert into public.employment_links(tenant_id,person_id,source_profile_id,registration_number,status)
     values($1,$2,null,'M1','rascunho')`,
    [tenantId, PERSON],
  );
  const link = await db.query(
    "select id from public.employment_links where registration_number='M1' and tenant_id=$1",
    [tenantId],
  );
  const linkId = link.rows[0].id;
  await db.query(
    `insert into public.vacation_policies(id,tenant_id,name,effective_from) values($1,$2,'Padrão','2020-01-01')`,
    [POLICY, tenantId],
  );
  await db.query(
    `insert into public.vacation_accrual_periods
       (id,tenant_id,employment_link_id,policy_id,accrual_start,accrual_end,concession_deadline,entitled_days)
     values($1,$2,$3,$4,'2023-01-01','2023-12-31','2025-01-01',30)`,
    [PERIOD, tenantId, linkId, POLICY],
  );
});

after(async () => {
  await db.close();
});

test("as tabelas de férias existem", async () => {
  const r = await db.query(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name = any($1)`,
    [["vacation_policies", "vacation_accrual_periods", "vacation_schedules"]],
  );
  assert.equal(r.rows.length, 3, "as três tabelas da Sprint 8 devem existir");
});

test("CHECK: política não aceita max_fractions > 3", async () => {
  await assert.rejects(
    db.query(
      `insert into public.vacation_policies(tenant_id,name,effective_from,max_fractions)
       values($1,'X','2020-01-01',4)`,
      [tenantId],
    ),
    /max_fractions|check/i,
  );
});

test("CHECK: pagamento de férias é antecipado (payment_date < start_date)", async () => {
  await assert.rejects(
    db.query(
      `insert into public.vacation_schedules
         (tenant_id,accrual_period_id,start_date,end_date,days,base_amount,bonus_amount,total_amount,payment_date,memory)
       values($1,$2,'2024-03-01','2024-03-10',10,1000,333,1333,'2024-03-05','{}'::jsonb)`,
      [tenantId, PERIOD],
    ),
    /payment_date|check/i,
  );
});

test("trigger: mais de três frações é bloqueado", async () => {
  await insertSchedule({
    id: "aaaaaaa1-0000-4000-8000-000000000001",
    start: "2024-03-01",
    end: "2024-03-05",
    days: 5,
  });
  await insertSchedule({
    id: "aaaaaaa1-0000-4000-8000-000000000002",
    start: "2024-04-01",
    end: "2024-04-05",
    days: 5,
  });
  await insertSchedule({
    id: "aaaaaaa1-0000-4000-8000-000000000003",
    start: "2024-05-01",
    end: "2024-05-05",
    days: 5,
  });
  await assert.rejects(
    insertSchedule({
      id: "aaaaaaa1-0000-4000-8000-000000000004",
      start: "2024-06-01",
      end: "2024-06-05",
      days: 5,
    }),
    /três frações/,
    "a quarta fração deve ser recusada pelo trigger",
  );
});

test("trigger: saldo de dias insuficiente é bloqueado", async () => {
  // Já há 15 dias programados (3×5); pedir 20 excede os 30 do período.
  await assert.rejects(
    insertSchedule({
      id: "bbbbbbb1-0000-4000-8000-000000000001",
      start: "2024-07-01",
      end: "2024-07-20",
      days: 20,
    }),
    /Saldo de dias insuficiente|três frações/,
    "estourar o saldo (ou o nº de frações) deve ser recusado",
  );
});
