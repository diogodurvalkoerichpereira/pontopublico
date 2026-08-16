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

  create table public.profiles (id uuid primary key, full_name text, email text);
  create table public.tenants (id uuid primary key, codigo text, nome text);
  create table public.persons (
    id uuid primary key, cpf text, full_name text not null, birth_date date,
    created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.unidades (
    id uuid primary key, tenant_id uuid not null references public.tenants(id),
    codigo text, nome text, ativo boolean default true
  );
  create table public.employment_links (
    id uuid primary key, tenant_id uuid not null references public.tenants(id),
    person_id uuid not null references public.persons(id),
    registration_number text not null, unit_id uuid references public.unidades(id),
    status text default 'ativo', termination_date date,
    created_at timestamptz default now(), updated_at timestamptz default now()
  );
  create table public.security_permissions (
    id uuid primary key default gen_random_uuid(), codigo text unique not null,
    modulo text not null, nome text not null, criticidade text not null
  );
  create table public.security_roles (
    id uuid primary key, tenant_id uuid not null references public.tenants(id),
    codigo text not null, nome text not null, ativo boolean default true
  );
  create table public.security_role_permissions (
    role_id uuid references public.security_roles(id),
    permission_id uuid references public.security_permissions(id),
    primary key(role_id,permission_id)
  );
  create table public.security_user_roles (
    id uuid primary key, tenant_id uuid references public.tenants(id),
    user_id uuid references public.profiles(id), role_id uuid references public.security_roles(id),
    valid_from date default current_date, valid_to date, revoked_at timestamptz
  );
  create table public.audit_events (
    id bigint generated always as identity primary key,
    tenant_id uuid, actor_id uuid, action text, resource text, record_id text,
    before_data jsonb, after_data jsonb, request_id text, ip inet,
    created_at timestamptz default now()
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
  insert into public.tenants values
    ('20000000-0000-4000-8000-000000000001','MAIN','Entidade principal'),
    ('20000000-0000-4000-8000-000000000002','OTHER','Outra entidade');
  insert into public.persons (id,cpf,full_name) values
    ('30000000-0000-4000-8000-000000000001','12345678901','Titular'),
    ('30000000-0000-4000-8000-000000000002','98765432100','Beneficiário'),
    ('30000000-0000-4000-8000-000000000003','98765432199','Segundo beneficiário');
  insert into public.unidades values
    ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','U1','Unidade 1',true),
    ('40000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','U2','Unidade externa',true);
  insert into public.employment_links
    (id,tenant_id,person_id,registration_number,unit_id,status) values
    ('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     '30000000-0000-4000-8000-000000000001','MAT-1',
     '40000000-0000-4000-8000-000000000001','ativo');
  insert into public.security_roles values
    ('60000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     'tenant_admin','Administrador',true);
  insert into public.security_user_roles values
    ('70000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     '10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001',current_date,null,null);
`);

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260816193000_sprint3_family_movements_payroll_catalog.sql",
    import.meta.url,
  ),
  "utf8",
);
await db.exec(migration);

let dependentValidityGuard = false;
try {
  await db.exec(`
    insert into public.person_dependents
      (tenant_id,holder_person_id,dependent_person_id,relationship,valid_from,valid_to)
    values ('20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002','Filho','2026-08-10','2026-08-01')
  `);
} catch (error) {
  dependentValidityGuard = String(error).includes("validity_check");
}
if (!dependentValidityGuard)
  throw new Error("Vigência inválida do dependente não foi bloqueada");

let pensionExclusiveGuard = false;
try {
  await db.exec(`
    insert into public.pension_beneficiaries
      (tenant_id,employment_link_id,beneficiary_person_id,calculation_type,
       percentage,fixed_amount,priority,valid_from)
    values ('20000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002','percentual',20,500,1,'2026-08-01')
  `);
} catch (error) {
  pensionExclusiveGuard = String(error).includes("exclusive_value_check");
}
if (!pensionExclusiveGuard)
  throw new Error("Percentual e valor fixo simultâneos não foram bloqueados");

await db.exec(`
  insert into public.pension_beneficiaries
    (tenant_id,employment_link_id,beneficiary_person_id,calculation_type,
     percentage,priority,valid_from)
  values ('20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002','percentual',20,1,'2026-08-01');
  insert into public.employment_link_movements
    (tenant_id,employment_link_id,movement_type,effective_date,from_unit_id,
     to_unit_id,from_status,to_status,before_data,after_data,legal_basis,
     document_path,document_sha256)
  values ('20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001','lotacao','2026-09-01',
    '40000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001','ativo','ativo',
    '{"unit":"old"}','{"unit":"new"}','Portaria 123',
    'doc.pdf','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
`);

let pensionRateGuard = false;
try {
  await db.exec(`
    insert into public.pension_beneficiaries
      (tenant_id,employment_link_id,beneficiary_person_id,calculation_type,
       percentage,priority,valid_from)
    values ('20000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000003','percentual',90,2,'2026-08-01')
  `);
} catch (error) {
  pensionRateGuard = String(error).includes("100%");
}
if (!pensionRateGuard)
  throw new Error("Rateio percentual acima de 100% não foi bloqueado");

let crossTenantMovementGuard = false;
try {
  await db.exec(`
    insert into public.employment_link_movements
      (tenant_id,employment_link_id,movement_type,effective_date,to_unit_id,legal_basis)
    values ('20000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001','lotacao','2026-09-02',
      '40000000-0000-4000-8000-000000000002','Portaria 456')
  `);
} catch (error) {
  crossTenantMovementGuard = String(error).includes("mesma entidade");
}
if (!crossTenantMovementGuard)
  throw new Error("Movimentação entre tenants não foi bloqueada");

await db.exec(`
  insert into public.payroll_rubrics
    (id,tenant_id,code,name,nature,unit,calculation_order)
  values
    ('80000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     'SAL','Salário','provento','valor',10),
    ('80000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',
     'INSS','INSS','desconto','percentual',20);
  insert into public.payroll_rubric_versions
    (id,tenant_id,rubric_id,version_number,valid_from,valid_to,status)
  values
    ('90000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
     '80000000-0000-4000-8000-000000000001',1,'2026-01-01','2026-12-31','publicada'),
    ('90000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',
     '80000000-0000-4000-8000-000000000002',1,'2026-01-01','2026-12-31','publicada');
  insert into public.payroll_rubric_incidences
    (tenant_id,version_id,base_code,factor)
  values ('20000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000001','inss',100);
  insert into public.payroll_rubric_incidences
    (tenant_id,version_id,depends_on_rubric_id,factor)
  values ('20000000-0000-4000-8000-000000000001',
    '90000000-0000-4000-8000-000000000001',
    '80000000-0000-4000-8000-000000000002',100);
`);

let overlappingVersionGuard = false;
try {
  await db.exec(`
    insert into public.payroll_rubric_versions
      (tenant_id,rubric_id,version_number,valid_from,valid_to,status)
    values ('20000000-0000-4000-8000-000000000001',
      '80000000-0000-4000-8000-000000000001',2,'2026-06-01','2027-01-01','publicada')
  `);
} catch (error) {
  overlappingVersionGuard = String(error).includes("sobrepõe");
}
if (!overlappingVersionGuard)
  throw new Error("Sobreposição de versões publicadas não foi bloqueada");

let cycleGuard = false;
try {
  await db.exec(`
    insert into public.payroll_rubric_incidences
      (tenant_id,version_id,depends_on_rubric_id,factor)
    values ('20000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000002',
      '80000000-0000-4000-8000-000000000001',100)
  `);
} catch (error) {
  cycleGuard = String(error).includes("ciclo");
}
if (!cycleGuard) throw new Error("Ciclo de incidências não foi bloqueado");

const bases = await db.query(`
  select public.payroll_project_bases(
    '20000000-0000-4000-8000-000000000001',
    '[{"version_id":"90000000-0000-4000-8000-000000000001","amount":5000}]'
  ) as result
`);
if (Number(bases.rows[0].result.inss) !== 5000)
  throw new Error("Projeção da base previdenciária não integrou a rubrica");

await db.exec(`
  select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
  set role authenticated;
`);
const rlsVisible = await db.query(
  "select count(*)::int as total from public.payroll_rubrics",
);
await db.exec("reset role");
if (rlsVisible.rows[0].total !== 2)
  throw new Error("RLS do catálogo não liberou o tenant autorizado");

const result = await db.query(`
  select
    (select count(*)::int from public.security_permissions) as permissions,
    (select count(*)::int from public.pension_beneficiaries) as pensions,
    (select count(*)::int from public.employment_link_movements) as movements,
    (select count(*)::int from public.payroll_rubrics) as rubrics,
    (select count(*)::int from public.payroll_rubric_versions) as versions,
    (select count(*)::int from public.payroll_rubric_incidences) as incidences
`);
console.log(
  JSON.stringify({
    ...result.rows[0],
    dependent_validity_guard: dependentValidityGuard,
    pension_exclusive_guard: pensionExclusiveGuard,
    pension_rate_guard: pensionRateGuard,
    cross_tenant_movement_guard: crossTenantMovementGuard,
    overlapping_version_guard: overlappingVersionGuard,
    incidence_cycle_guard: cycleGuard,
    base_projection: bases.rows[0].result,
    rls_catalog_guard: true,
  }),
);
await db.close();
