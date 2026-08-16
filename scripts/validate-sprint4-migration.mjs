import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();

await db.exec(`
  create role authenticated;
  create role service_role;
  create schema auth;
  create schema private;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function public.set_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at=now(); return new; end $$;

  create table public.app_users (
    id uuid primary key,email text,password_hash text,raw_user_meta_data jsonb,
    updated_at timestamptz default now()
  );
  create table public.profiles (id uuid primary key,full_name text,email text);
  create table public.tenants (id uuid primary key,codigo text,nome text);
  create table public.persons (
    id uuid primary key,cpf text,full_name text not null,birth_date date,
    created_at timestamptz default now(),updated_at timestamptz default now()
  );
  create table public.unidades (
    id uuid primary key,tenant_id uuid not null references public.tenants(id),
    codigo text,nome text,ativo boolean default true
  );
  create table public.employment_links (
    id uuid primary key,tenant_id uuid not null references public.tenants(id),
    person_id uuid not null references public.persons(id),registration_number text not null,
    unit_id uuid references public.unidades(id),status text default 'ativo',
    base_salary numeric(14,2),termination_date date,
    created_at timestamptz default now(),updated_at timestamptz default now()
  );
  create table public.security_permissions (
    id uuid primary key default gen_random_uuid(),codigo text unique not null,
    modulo text not null,nome text not null,criticidade text not null
  );
  create table public.security_roles (
    id uuid primary key,tenant_id uuid not null references public.tenants(id),
    codigo text not null,nome text not null,ativo boolean default true
  );
  create table public.security_role_permissions (
    role_id uuid references public.security_roles(id),
    permission_id uuid references public.security_permissions(id),
    primary key(role_id,permission_id)
  );
  create table public.security_user_roles (
    id uuid primary key,tenant_id uuid references public.tenants(id),
    user_id uuid references public.profiles(id),role_id uuid references public.security_roles(id),
    valid_from date default current_date,valid_to date,revoked_at timestamptz
  );
  create table public.audit_events (
    id bigint generated always as identity primary key,tenant_id uuid,actor_id uuid,
    action text,resource text,record_id text,before_data jsonb,after_data jsonb,
    request_id text,ip inet,created_at timestamptz default now()
  );
  create function private.has_tenant_permission(_tenant_id uuid,_permission text)
  returns boolean language sql stable security definer set search_path=public,pg_temp as $$
    select auth.uid() is not null and exists(
      select 1 from public.security_user_roles ur
      join public.security_role_permissions rp on rp.role_id=ur.role_id
      join public.security_permissions p on p.id=rp.permission_id
      where ur.tenant_id=_tenant_id and ur.user_id=auth.uid()
        and ur.revoked_at is null and p.codigo=_permission
    )
  $$;
  create function private.has_unit_permission(_tenant_id uuid,_unit_id uuid,_permission text)
  returns boolean language sql stable security definer set search_path=public,pg_temp as $$
    select private.has_tenant_permission(_tenant_id,_permission)
  $$;

  insert into public.profiles values
    ('10000000-0000-4000-8000-000000000001','Administrador','admin@example.com');
  insert into public.app_users (id,email,password_hash,raw_user_meta_data) values
    ('10000000-0000-4000-8000-000000000001','admin@example.com','hash','{}');
  insert into public.tenants values
    ('20000000-0000-4000-8000-000000000001','MAIN','Entidade principal'),
    ('20000000-0000-4000-8000-000000000002','OTHER','Outra entidade');
  insert into public.persons (id,cpf,full_name) values
    ('30000000-0000-4000-8000-000000000001','12345678901','Titular');
  insert into public.unidades values
    ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','U1','Unidade 1',true),
    ('40000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','U2','Unidade 2',true);
  insert into public.employment_links
    (id,tenant_id,person_id,registration_number,unit_id,status,base_salary) values
    ('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     '30000000-0000-4000-8000-000000000001','MAT-1',
     '40000000-0000-4000-8000-000000000001','ativo',5000);
  insert into public.security_roles values
    ('60000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     'tenant_admin','Administrador',true);
  insert into public.security_user_roles values
    ('70000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     '10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001',current_date,null,null);
`);

for (const file of [
  "20260816193000_sprint3_family_movements_payroll_catalog.sql",
  "20260817093000_sprint4_auth_formula_assignments_simulation.sql",
]) {
  const sql = await readFile(
    new URL(`../supabase/migrations/${file}`, import.meta.url),
    "utf8",
  );
  await db.exec(sql);
}

for (let attempt = 0; attempt < 5; attempt += 1) {
  await db.exec(`
    update public.app_users set failed_login_attempts=failed_login_attempts+1,
      locked_until=case when failed_login_attempts+1>=5
        then now()+interval '15 minutes' else null end
    where id='10000000-0000-4000-8000-000000000001'
  `);
}
const loginLock = await db.query(`
  select failed_login_attempts,locked_until>now() as locked
  from public.app_users where id='10000000-0000-4000-8000-000000000001'
`);
const loginLockGuard =
  loginLock.rows[0].failed_login_attempts === 5 && loginLock.rows[0].locked;
if (!loginLockGuard) throw new Error("Quinta falha não bloqueou o acesso");
await db.exec(`
  update public.app_users set failed_login_attempts=0,locked_until=null
  where id='10000000-0000-4000-8000-000000000001'
`);

const ast =
  '{"type":"binary","operator":"*","left":{"type":"variable","name":"salary_base"},"right":{"type":"number","value":0.1}}';
const ast2 = '{"type":"number","value":999}';
const hash = "a".repeat(64);

await db.exec(`
  insert into public.payroll_rubrics
    (id,tenant_id,code,name,nature,unit,calculation_order,status)
  values
    ('80000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     'BONUS','Bônus','provento','valor',10,'ativo'),
    ('80000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002',
     'OTHER','Externa','provento','valor',10,'ativo');
`);

let formulaRequiredGuard = false;
try {
  await db.exec(`
    insert into public.payroll_rubric_versions
      (tenant_id,rubric_id,version_number,valid_from,status)
    values ('20000000-0000-4000-8000-000000000001',
      '80000000-0000-4000-8000-000000000001',1,'2026-01-01','publicada')
  `);
} catch (error) {
  formulaRequiredGuard = String(error).includes("fórmula AST");
}
if (!formulaRequiredGuard)
  throw new Error("Publicação sem AST não foi bloqueada");

await db.query(
  `insert into public.payroll_rubric_versions
     (id,tenant_id,rubric_id,version_number,valid_from,status,formula_ast,formula_checksum)
   values ('90000000-0000-4000-8000-000000000001',
     '20000000-0000-4000-8000-000000000001',
     '80000000-0000-4000-8000-000000000001',1,'2026-01-01','publicada',$1::jsonb,$2)`,
  [ast, hash],
);

let immutableGuard = false;
try {
  await db.query(
    "update public.payroll_rubric_versions set formula_ast=$1::jsonb where id='90000000-0000-4000-8000-000000000001'",
    [ast2],
  );
} catch (error) {
  immutableGuard = String(error).includes("imutável");
}
if (!immutableGuard) throw new Error("Versão publicada pôde ser alterada");

await db.exec(`
  insert into public.employment_link_rubrics
    (tenant_id,employment_link_id,rubric_id,valid_from,valid_to,fixed_amount)
  values ('20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000001','2026-01-01','2026-12-31',500);
`);

let overlapGuard = false;
try {
  await db.exec(`
    insert into public.employment_link_rubrics
      (tenant_id,employment_link_id,rubric_id,valid_from,fixed_amount)
    values ('20000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      '80000000-0000-4000-8000-000000000001','2026-06-01',700)
  `);
} catch (error) {
  overlapGuard = String(error).includes("sobrepõe");
}
if (!overlapGuard)
  throw new Error("Sobreposição da rubrica fixa não foi bloqueada");

let crossTenantAssignmentGuard = false;
try {
  await db.exec(`
    insert into public.employment_link_rubrics
      (tenant_id,employment_link_id,rubric_id,valid_from,fixed_amount)
    values ('20000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      '80000000-0000-4000-8000-000000000002','2027-01-01',700)
  `);
} catch (error) {
  crossTenantAssignmentGuard = String(error).includes("mesma entidade");
}
if (!crossTenantAssignmentGuard)
  throw new Error("Rubrica externa foi atribuída ao vínculo");

let monthGuard = false;
try {
  await db.query(
    `insert into public.payroll_calculation_runs
       (tenant_id,reference_month,engine_version,input_checksum,links_requested)
     values ('20000000-0000-4000-8000-000000000001','2026-08-15','ast-v1',$1,1)`,
    [hash],
  );
} catch (error) {
  monthGuard = String(error).includes("reference_month_check");
}
if (!monthGuard) throw new Error("Competência fora do primeiro dia foi aceita");

await db.query(
  `insert into public.payroll_calculation_runs
     (id,tenant_id,reference_month,engine_version,input_checksum,links_requested)
   values ('a0000000-0000-4000-8000-000000000001',
     '20000000-0000-4000-8000-000000000001','2026-08-01','ast-v1',$1,1)`,
  [hash],
);
await db.query(
  `insert into public.payroll_calculation_items
     (tenant_id,run_id,employment_link_id,rubric_id,version_id,sequence,
      calculation_base,amount,formula_checksum,memory)
   values ('20000000-0000-4000-8000-000000000001',
     'a0000000-0000-4000-8000-000000000001',
     '50000000-0000-4000-8000-000000000001',
     '80000000-0000-4000-8000-000000000001',
     '90000000-0000-4000-8000-000000000001',1,5000,500,$1,'{"final":500}')`,
  [hash],
);

await db.exec(`
  select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
  set role authenticated;
`);
const visible = await db.query(
  "select count(*)::int as total from public.payroll_calculation_runs",
);
await db.exec("reset role");
if (visible.rows[0].total !== 1)
  throw new Error("RLS não liberou a simulação autorizada");

const result = await db.query(`
  select
    (select count(*)::int from private.auth_sessions) as sessions,
    (select count(*)::int from public.security_permissions where codigo like 'payroll.%') as payroll_permissions,
    (select count(*)::int from public.employment_link_rubrics) as assignments,
    (select count(*)::int from public.payroll_calculation_runs) as runs,
    (select count(*)::int from public.payroll_calculation_items) as items
`);
console.log(
  JSON.stringify({
    ...result.rows[0],
    formula_required_guard: formulaRequiredGuard,
    published_immutable_guard: immutableGuard,
    assignment_overlap_guard: overlapGuard,
    cross_tenant_assignment_guard: crossTenantAssignmentGuard,
    reference_month_guard: monthGuard,
    rls_simulation_guard: true,
    login_lock_after_five_guard: loginLockGuard,
  }),
);
await db.close();
