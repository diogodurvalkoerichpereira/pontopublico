import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

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
    person_id uuid references public.persons(id),registration_number text
  );
  create table public.payroll_rubrics(
    id uuid primary key,tenant_id uuid references public.tenants(id),
    code text,nature text
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
    ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','MAT-1');
  insert into public.payroll_calculation_runs values
    ('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','2026-08-01','simulacao','concluida');
  insert into public.security_roles values
    ('60000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','tenant_admin','Admin',true);
`);

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260817113000_sprint5_payroll_cycle.sql",
    import.meta.url,
  ),
  "utf8",
);
await db.exec(migration);
const hash = "a".repeat(64);
await db.query(
  `insert into public.payroll_cycles
     (id,tenant_id,reference_month,source_run_id,prepared_by)
   values ('70000000-0000-4000-8000-000000000001',
     '20000000-0000-4000-8000-000000000001','2026-08-01',
     '50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001')`,
);
await db.query(
  `insert into public.payroll_cycle_results
     (tenant_id,cycle_id,employment_link_id,source_run_id,earnings,deductions,
      net_amount,items_count,calculation_memory,result_checksum)
   values ('20000000-0000-4000-8000-000000000001',
     '70000000-0000-4000-8000-000000000001',
     '40000000-0000-4000-8000-000000000001',
     '50000000-0000-4000-8000-000000000001',5000,500,4500,2,'[]',$1)`,
  [hash],
);

let crossTenantGuard = false;
try {
  await db.exec(`
    insert into public.payroll_cycles
      (tenant_id,reference_month,source_run_id,prepared_by)
    values ('20000000-0000-4000-8000-000000000002','2026-08-01',
      '50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001')
  `);
} catch (error) {
  crossTenantGuard = String(error).includes("mesma entidade");
}
if (!crossTenantGuard)
  throw new Error("Simulação cruzada entre entidades foi aceita");

let invalidTransitionGuard = false;
try {
  await db.exec(`update public.payroll_cycles set status='fechada'
    where id='70000000-0000-4000-8000-000000000001'`);
} catch (error) {
  invalidTransitionGuard = String(error).includes("Transição inválida");
}
if (!invalidTransitionGuard) throw new Error("Salto de situação foi aceito");

await db.exec(`
  update public.payroll_cycles set status='em_conferencia',review_started_at=now()
    where id='70000000-0000-4000-8000-000000000001';
  update public.payroll_cycles set status='aprovada',approved_at=now()
    where id='70000000-0000-4000-8000-000000000001';
  update public.payroll_cycles set status='fechada',closed_at=now()
    where id='70000000-0000-4000-8000-000000000001';
`);
let closedImmutableGuard = false;
try {
  await db.exec(`delete from public.payroll_cycle_results
    where cycle_id='70000000-0000-4000-8000-000000000001'`);
} catch (error) {
  closedImmutableGuard = String(error).includes("reabertura");
}
if (!closedImmutableGuard)
  throw new Error("Resultado fechado pôde ser excluído");

let reopenReasonGuard = false;
try {
  await db.exec(`update public.payroll_cycles set status='reaberta',reopen_reason='curta'
    where id='70000000-0000-4000-8000-000000000001'`);
} catch (error) {
  reopenReasonGuard = String(error).includes("reopen_reason_check");
}
if (!reopenReasonGuard)
  throw new Error("Reabertura sem justificativa suficiente foi aceita");

await db.exec(`
  update public.payroll_cycles set status='reaberta',reopen_reason='Correção formal necessária'
    where id='70000000-0000-4000-8000-000000000001';
  delete from public.payroll_cycle_results
    where cycle_id='70000000-0000-4000-8000-000000000001';
  update public.payroll_cycles set status='previa',version=2
    where id='70000000-0000-4000-8000-000000000001';
`);

const permissions = await db.query(`select count(*)::int total
  from public.security_permissions where codigo like 'payroll.cycles.%'`);
if (permissions.rows[0].total !== 5)
  throw new Error("Permissões do ciclo incompletas");

await db.exec(`
  select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
  set role authenticated;
`);
const visible = await db.query(
  "select count(*)::int total from public.payroll_cycles",
);
await db.exec("reset role");
if (visible.rows[0].total !== 1)
  throw new Error("RLS não liberou o ciclo autorizado");

const serverSource = await readFile(
  new URL("../src/lib/payroll-cycle.functions.ts", import.meta.url),
  "utf8",
);
if (!serverSource.includes("quem preparou não pode aprovar"))
  throw new Error("Segregação entre preparação e aprovação ausente");
if (!serverSource.includes("for update"))
  throw new Error("Controle concorrente do ciclo ausente");

console.log(
  JSON.stringify(
    {
      permissions: permissions.rows[0].total,
      cross_tenant_guard: crossTenantGuard,
      invalid_transition_guard: invalidTransitionGuard,
      closed_result_immutable_guard: closedImmutableGuard,
      reopen_reason_guard: reopenReasonGuard,
      version_after_reopen: 2,
      maker_checker_guard: true,
      rls_guard: true,
    },
    null,
    2,
  ),
);
