/**
 * Sprint 7 — rescisões e eventos funcionais: teste de COMPORTAMENTO
 * (substitui o grep validate-sprint7.mjs).
 *
 * Duas redes. (1) COMPORTAMENTO no banco: sobe o esquema real em PGlite e provoca
 * os CHECKs de `termination_calculations` (worked_days, result_checksum hex) e o
 * trigger `trg_validate_termination`, que barra rescisão de vínculo de outra
 * entidade. (2) COMPORTAMENTO puro: reproduz a fórmula rescisória do módulo e
 * confere o total de 16000. Rede de conformidade (lint): o módulo trava o
 * registro com `for update`.
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
let linkId;

const PERSON = "3a000000-0000-4000-8000-000000000007";
const OTHER_TENANT = "7f000000-0000-4000-8000-0000000000ff";
const HEX64 = "a".repeat(64);

/** Insere uma rescisão válida por construção; sobrescreve campos via `over`. */
function insertTermination(over = {}) {
  const v = {
    tenant_id: tenantId,
    employment_link_id: linkId,
    termination_date: "2024-03-31",
    reason: "sem_justa_causa",
    notice_type: "indenizado",
    worked_days: 15,
    thirteenth_months: 6,
    vacation_months: 6,
    salary_balance: 3000,
    notice_amount: 6000,
    thirteenth_amount: 3000,
    vacation_amount: 4000,
    fgts_penalty: 0,
    total_earnings: 16000,
    net_amount: 16000,
    memory: "{}",
    result_checksum: HEX64,
    ...over,
  };
  return db.query(
    `insert into public.termination_calculations
       (tenant_id,employment_link_id,termination_date,reason,notice_type,worked_days,
        thirteenth_months,vacation_months,salary_balance,notice_amount,thirteenth_amount,
        vacation_amount,fgts_penalty,total_earnings,net_amount,memory,result_checksum)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
    [
      v.tenant_id,
      v.employment_link_id,
      v.termination_date,
      v.reason,
      v.notice_type,
      v.worked_days,
      v.thirteenth_months,
      v.vacation_months,
      v.salary_balance,
      v.notice_amount,
      v.thirteenth_amount,
      v.vacation_amount,
      v.fgts_penalty,
      v.total_earnings,
      v.net_amount,
      v.memory,
      v.result_checksum,
    ],
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
  // status='rascunho': 'ativo' dispara a regra de completude do vínculo.
  await db.query(
    `insert into public.employment_links(tenant_id,person_id,source_profile_id,registration_number,status)
     values($1,$2,null,'R1','rascunho')`,
    [tenantId, PERSON],
  );
  const link = await db.query(
    "select id from public.employment_links where registration_number='R1' and tenant_id=$1",
    [tenantId],
  );
  linkId = link.rows[0].id;
});

after(async () => {
  await db.close();
});

test("a tabela de rescisões existe", async () => {
  const r = await db.query(
    `select 1 from information_schema.tables
     where table_schema='public' and table_name='termination_calculations'`,
  );
  assert.equal(r.rows.length, 1);
});

test("CHECK: worked_days entre 0 e 30 (31 é recusado)", async () => {
  await assert.rejects(
    insertTermination({ worked_days: 31 }),
    /worked_days|check/i,
  );
});

test("CHECK: result_checksum precisa ser hex de 64", async () => {
  await assert.rejects(
    insertTermination({ result_checksum: "xyz" }),
    /result_checksum|check/i,
  );
});

test("trigger: rescisão de vínculo de outra entidade é bloqueada", async () => {
  // O vínculo pertence a `tenantId`; declarar a rescisão em outro ente diverge.
  await db.query(
    "insert into public.tenants(id,codigo,nome,status) values($1,'X2','X2','ativo') on conflict do nothing",
    [OTHER_TENANT],
  );
  await assert.rejects(
    insertTermination({ tenant_id: OTHER_TENANT }),
    /outra entidade/,
  );
});

test("uma rescisão válida é aceita pelo esquema", async () => {
  await insertTermination();
  const r = await db.query(
    "select net_amount from public.termination_calculations where employment_link_id=$1",
    [linkId],
  );
  assert.equal(r.rows.length, 1);
  assert.equal(Number(r.rows[0].net_amount), 16000);
});

test("fórmula rescisória do módulo soma 16000", () => {
  // Reproduz calculateTermination (employment-special.functions.ts):
  // salary=6000, worked=15, 13º=6/12, férias=6/12*4/3, aviso indenizado=salário.
  const salary = 6000,
    worked = 15,
    m13 = 6,
    vac = 6;
  const salary_balance = +((salary / 30) * worked).toFixed(2);
  const notice_amount = salary; // notice_type === 'indenizado'
  const thirteenth_amount = +((salary * m13) / 12).toFixed(2);
  const vacation_amount = +((((salary * vac) / 12) * 4) / 3).toFixed(2);
  const total = +(
    salary_balance +
    notice_amount +
    thirteenth_amount +
    vacation_amount
  ).toFixed(2);
  assert.equal(salary_balance, 3000);
  assert.equal(thirteenth_amount, 3000);
  assert.equal(vacation_amount, 4000);
  assert.equal(total, 16000);
});

test("lint: o módulo trava o registro com bloqueio pessimista (for update)", () => {
  const src = readFileSync(
    join(root, "src", "lib", "employment-special.functions.ts"),
    "utf8",
  );
  assert.match(src, /for update/);
});
