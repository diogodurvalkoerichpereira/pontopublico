import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  calculateThirteenthSalary,
  countThirteenthSalaryMonths,
} from "../src/lib/payroll-special.ts";

const monthsFull = countThirteenthSalaryMonths(2026, "2025-01-01", null);
const monthsAfterCutoff = countThirteenthSalaryMonths(2026, "2026-06-17", null);
if (monthsFull !== 12 || monthsAfterCutoff !== 6)
  throw new Error("Contagem de avos do 13º inválida");

const bands = [
  { ate: 1500, aliquota: 0.075 },
  { ate: 3000, aliquota: 0.09 },
  { ate: 8000, aliquota: 0.12 },
];
const incomeBands = [
  { ate: 2500, aliquota: 0, deduzir: 0 },
  { ate: 999999, aliquota: 0.15, deduzir: 375 },
];
const first = calculateThirteenthSalary({
  calculationBase: 6000,
  months: 12,
  installment: "primeira",
  socialSecurityBands: bands,
  socialSecurityCeiling: 8000,
  incomeTaxBands: incomeBands,
});
if (first.netAmount !== 3000 || first.deductions !== 0)
  throw new Error("Primeira parcela do 13º inválida");
const second = calculateThirteenthSalary({
  calculationBase: 6000,
  months: 12,
  installment: "segunda",
  firstInstallmentPaid: first.netAmount,
  socialSecurityBands: bands,
  socialSecurityCeiling: 8000,
  incomeTaxBands: incomeBands,
});
if (
  second.earnings !== 6000 ||
  second.firstInstallmentCompensation !== 3000 ||
  second.netAmount !== 1958.62
)
  throw new Error(`Segunda parcela inválida: ${JSON.stringify(second)}`);

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth; create schema private;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  create function public.set_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at=now(); return new; end $$;
  create table public.profiles(id uuid primary key);
  create table public.tenants(id uuid primary key);
  create table public.persons(id uuid primary key,full_name text not null);
  create table public.employment_links(
    id uuid primary key,tenant_id uuid references public.tenants(id),
    person_id uuid references public.persons(id),registration_number text,
    admission_date date,termination_date date,status text,base_salary numeric,unit_id uuid
  );
  create table public.payroll_calculation_runs(
    id uuid primary key,tenant_id uuid references public.tenants(id),
    reference_month date,run_type text default 'simulacao',status text default 'concluida'
  );
  create table public.security_permissions(
    id uuid primary key default gen_random_uuid(),codigo text unique,
    modulo text,nome text,criticidade text
  );
  create table public.security_roles(
    id uuid primary key,tenant_id uuid references public.tenants(id),
    codigo text,nome text,ativo boolean default true
  );
  create table public.security_role_permissions(
    role_id uuid references public.security_roles(id),
    permission_id uuid references public.security_permissions(id),
    primary key(role_id,permission_id)
  );
  create table public.audit_events(
    id bigint generated always as identity primary key,tenant_id uuid,actor_id uuid,
    action text,resource text,record_id text,before_data jsonb,after_data jsonb,
    request_id text,ip inet,created_at timestamptz default now()
  );
  create function private.has_tenant_permission(_tenant uuid,_permission text)
  returns boolean language sql stable security definer set search_path=public,pg_temp as $$
    select auth.uid() is not null and exists(
      select 1 from public.security_role_permissions rp
      join public.security_roles r on r.id=rp.role_id and r.tenant_id=_tenant
      join public.security_permissions p on p.id=rp.permission_id
      where p.codigo=_permission
    ) $$;
  insert into public.profiles values ('10000000-0000-4000-8000-000000000001');
  insert into public.tenants values
    ('20000000-0000-4000-8000-000000000001'),
    ('20000000-0000-4000-8000-000000000002');
  insert into public.persons values ('30000000-0000-4000-8000-000000000001','Servidor');
  insert into public.employment_links values
    ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     '30000000-0000-4000-8000-000000000001','MAT-1','2025-01-01',null,'ativo',6000,null);
  insert into public.security_roles values
    ('60000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     'tenant_admin','Admin',true);
`);
for (const file of [
  "20260817113000_sprint5_payroll_cycle.sql",
  "20260817143000_sprint6_special_payrolls.sql",
]) {
  const sql = await readFile(
    new URL(`../supabase/migrations/${file}`, import.meta.url),
    "utf8",
  );
  await db.exec(sql);
}

await db.exec(`
  insert into public.payroll_cycles
    (id,tenant_id,reference_month,cycle_type,status,prepared_by)
  values ('70000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001','2026-08-01','mensal','previa',
    '10000000-0000-4000-8000-000000000001');
  update public.payroll_cycles set status='em_conferencia'
    where id='70000000-0000-4000-8000-000000000001';
  update public.payroll_cycles set status='aprovada'
    where id='70000000-0000-4000-8000-000000000001';
  update public.payroll_cycles set status='fechada'
    where id='70000000-0000-4000-8000-000000000001';
  insert into public.payroll_cycles
    (id,tenant_id,reference_month,cycle_type,status,source_cycle_id,prepared_by)
  values ('70000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001','2026-08-01','complementar','previa',
    '70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
  insert into public.payroll_special_adjustments
    (tenant_id,cycle_id,employment_link_id,nature,amount,reason,created_by)
  values ('20000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000001','provento',250,'Diferença salarial',
    '10000000-0000-4000-8000-000000000001');
`);

let sourceGuard = false;
try {
  await db.exec(`
    insert into public.payroll_cycles
      (tenant_id,reference_month,cycle_type,status,source_cycle_id,prepared_by,sequence)
    values ('20000000-0000-4000-8000-000000000002','2026-08-01','complementar','previa',
      '70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',2)
  `);
} catch (error) {
  sourceGuard = String(error).includes("mesma entidade");
}
if (!sourceGuard)
  throw new Error("Complementar aceitou origem de outra entidade");

await db.exec(`
  insert into public.payroll_cycles
    (id,tenant_id,reference_month,cycle_type,status,prepared_by,total_earnings,total_net)
  values ('80000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001','2026-09-01','adiantamento','previa',
    '10000000-0000-4000-8000-000000000001',2400,2400);
  insert into public.payroll_cycle_results
    (tenant_id,cycle_id,employment_link_id,earnings,net_amount,items_count,
     calculation_memory,result_checksum)
  values ('20000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',2400,2400,1,'[]','${"b".repeat(64)}');
  update public.payroll_cycles set status='em_conferencia'
    where id='80000000-0000-4000-8000-000000000001';
  update public.payroll_cycles set status='aprovada'
    where id='80000000-0000-4000-8000-000000000001';
  update public.payroll_cycles set status='fechada'
    where id='80000000-0000-4000-8000-000000000001';
  insert into public.payroll_cycles
    (id,tenant_id,reference_month,cycle_type,status,prepared_by)
  values ('80000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001','2026-09-01','mensal','previa',
    '10000000-0000-4000-8000-000000000001');
  insert into public.payroll_advance_compensations
    (tenant_id,advance_cycle_id,monthly_cycle_id,employment_link_id,amount)
  values ('20000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000001',2400);
`);

let duplicateCompensationGuard = false;
try {
  await db.exec(`insert into public.payroll_advance_compensations
    (tenant_id,advance_cycle_id,monthly_cycle_id,employment_link_id,amount)
    values ('20000000-0000-4000-8000-000000000001',
      '80000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002',
      '40000000-0000-4000-8000-000000000001',2400)`);
} catch (error) {
  duplicateCompensationGuard = String(error).includes(
    "payroll_advance_compensations_unique",
  );
}
if (!duplicateCompensationGuard)
  throw new Error("Adiantamento pôde ser compensado duas vezes");

const permissions = await db.query(`select count(*)::int total
  from public.security_permissions where codigo like 'payroll.special.%'`);
if (permissions.rows[0].total !== 2)
  throw new Error("Permissões especiais incompletas");

const serverSource = await readFile(
  new URL("../src/lib/payroll-special.functions.ts", import.meta.url),
  "utf8",
);
const monthlySource = await readFile(
  new URL("../src/lib/payroll-cycle.functions.ts", import.meta.url),
  "utf8",
);
for (const guard of [
  "media_remuneratoria",
  "primeira parcela fechada",
  "source_cycle_id",
]) {
  if (!serverSource.includes(guard)) throw new Error(`Regra ausente: ${guard}`);
}
if (!monthlySource.includes("compensacao_adiantamento"))
  throw new Error("Compensação na folha mensal ausente");

console.log(
  JSON.stringify(
    {
      thirteenth_full_months: monthsFull,
      thirteenth_cutoff_months: monthsAfterCutoff,
      first_installment: first.netAmount,
      second_installment_net: second.netAmount,
      source_tenant_guard: sourceGuard,
      duplicate_advance_compensation_guard: duplicateCompensationGuard,
      special_permissions: permissions.rows[0].total,
      monthly_compensation_hook: true,
    },
    null,
    2,
  ),
);
