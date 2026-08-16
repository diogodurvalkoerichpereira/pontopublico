-- Sprint 20: staging, validação e reconciliação de até 15 anos de histórico.
insert into public.security_permissions(codigo,nome,modulo) values
('migration.read','Consultar migrações históricas','migration'),('migration.manage','Executar migrações históricas','migration') on conflict(codigo) do nothing;
insert into public.security_role_permissions(role_id,permission_id) select r.id,p.id from public.security_roles r join public.security_permissions p on p.codigo in('migration.read','migration.manage') where r.codigo='tenant_admin' on conflict do nothing;
create table if not exists public.historical_migration_jobs(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete cascade,name text not null,source_type text not null,
 status text not null default 'draft' check(status in('draft','staged','reconciled','committed','failed')),
 expected_rows bigint not null check(expected_rows>=0),expected_total numeric(20,2) not null default 0,
 staged_rows bigint not null default 0,valid_rows bigint not null default 0,staged_total numeric(20,2) not null default 0,
 checksum text,created_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),committed_at timestamptz
);
create table if not exists public.historical_migration_rows(
 id uuid primary key default gen_random_uuid(),job_id uuid not null references public.historical_migration_jobs(id) on delete cascade,tenant_id uuid not null references public.tenants(id) on delete cascade,
 source_key text not null,reference_date date not null,amount numeric(20,2) not null default 0,payload jsonb not null,
 row_status text not null check(row_status in('valid','invalid')),validation_errors text[] not null default '{}',created_at timestamptz not null default now(),unique(job_id,source_key)
);
create table if not exists public.historical_records(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete cascade,job_id uuid not null references public.historical_migration_jobs(id),source_type text not null,source_key text not null,reference_date date not null,amount numeric(20,2) not null,payload jsonb not null,imported_at timestamptz not null default now(),unique(tenant_id,source_type,source_key)
);
create index if not exists historical_rows_job_status_idx on public.historical_migration_rows(job_id,row_status);create index if not exists historical_records_tenant_date_idx on public.historical_records(tenant_id,reference_date);
alter table public.historical_migration_jobs enable row level security;alter table public.historical_migration_rows enable row level security;alter table public.historical_records enable row level security;
create policy migration_jobs_member on public.historical_migration_jobs for select to authenticated using(private.is_tenant_member(tenant_id));
create policy migration_rows_member on public.historical_migration_rows for select to authenticated using(private.is_tenant_member(tenant_id));
create policy historical_records_member on public.historical_records for select to authenticated using(private.is_tenant_member(tenant_id));
revoke all on public.historical_migration_jobs,public.historical_migration_rows,public.historical_records from anon;grant select on public.historical_migration_jobs,public.historical_migration_rows,public.historical_records to authenticated;
