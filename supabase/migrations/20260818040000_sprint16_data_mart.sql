-- Sprint 16: data mart privado de folha, rubricas e movimentações.
insert into public.security_permissions(codigo,nome,modulo) values
('analytics.read','Consultar data mart','analytics'),('analytics.manage','Atualizar data mart','analytics') on conflict(codigo) do nothing;
insert into public.security_role_permissions(role_id,permission_id) select r.id,p.id from public.security_roles r join public.security_permissions p on p.codigo in('analytics.read','analytics.manage') where r.codigo='tenant_admin' on conflict do nothing;
create schema if not exists analytics;
revoke all on schema analytics from public, anon, authenticated;
create table if not exists analytics.etl_runs(
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null check(status in('running','completed','failed')),
  source_rows bigint not null default 0, mart_rows bigint not null default 0,
  source_total numeric(18,2) not null default 0, mart_total numeric(18,2) not null default 0,
  checksum text, error_message text, created_by uuid not null
);
create table if not exists analytics.fact_payroll(
  tenant_id uuid not null, cycle_id uuid not null, reference_month date not null,
  cycle_type text not null, links_count integer not null,
  total_earnings numeric(18,2) not null, total_deductions numeric(18,2) not null,
  total_net numeric(18,2) not null, source_updated_at timestamptz,
  loaded_at timestamptz not null default now(), primary key(tenant_id,cycle_id)
);
create table if not exists analytics.fact_payroll_item(
  tenant_id uuid not null, cycle_id uuid not null, item_id uuid not null,
  link_id uuid not null, rubric_id uuid, unit_id uuid,
  earnings numeric(18,2) not null default 0, deductions numeric(18,2) not null default 0,
  net numeric(18,2) not null default 0, loaded_at timestamptz not null default now(),
  primary key(tenant_id,item_id)
);
create table if not exists analytics.fact_movement(
  tenant_id uuid not null, movement_id uuid not null, link_id uuid not null,
  unit_id uuid, movement_type text not null, effective_date date not null,
  loaded_at timestamptz not null default now(), primary key(tenant_id,movement_id)
);
create index if not exists fact_payroll_month_idx on analytics.fact_payroll(tenant_id,reference_month);
create index if not exists fact_movement_date_idx on analytics.fact_movement(tenant_id,effective_date);
grant usage on schema analytics to service_role;
grant select,insert,update,delete on all tables in schema analytics to service_role;
