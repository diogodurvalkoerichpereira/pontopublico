-- Sprint 17: RCL, despesa com pessoal e alertas parametrizáveis da LRF.
insert into public.security_permissions(codigo,nome,modulo) values
('fiscal.read','Consultar indicadores fiscais','fiscal'),('fiscal.manage','Gerenciar bases fiscais','fiscal') on conflict(codigo) do nothing;
insert into public.security_role_permissions(role_id,permission_id) select r.id,p.id from public.security_roles r join public.security_permissions p on p.codigo in('fiscal.read','fiscal.manage') where r.codigo='tenant_admin' on conflict do nothing;
create table if not exists public.fiscal_limit_configs(
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  legal_limit numeric(7,6) not null default .54 check(legal_limit>0 and legal_limit<=1),
  prudential_ratio numeric(7,6) not null default .95 check(prudential_ratio>0 and prudential_ratio<=1),
  warning_ratio numeric(7,6) not null default .90 check(warning_ratio>0 and warning_ratio<=1),
  legal_basis text not null default 'LC 101/2000, arts. 20, 22 e 59',
  source_url text not null default 'https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp101.htm',
  updated_by uuid references public.profiles(id), updated_at timestamptz not null default now()
);
create table if not exists public.fiscal_monthly_balances(
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  reference_month date not null check(reference_month=date_trunc('month',reference_month)::date),
  net_current_revenue numeric(18,2) not null check(net_current_revenue>=0),
  personnel_expense numeric(18,2) not null check(personnel_expense>=0),
  source_document text, updated_by uuid not null references public.profiles(id), updated_at timestamptz not null default now(),
  primary key(tenant_id,reference_month)
);
alter table public.fiscal_limit_configs enable row level security;
alter table public.fiscal_monthly_balances enable row level security;
create policy fiscal_config_member_read on public.fiscal_limit_configs for select to authenticated using(private.is_tenant_member(tenant_id));
create policy fiscal_balance_member_read on public.fiscal_monthly_balances for select to authenticated using(private.is_tenant_member(tenant_id));
revoke all on public.fiscal_limit_configs,public.fiscal_monthly_balances from anon;
grant select on public.fiscal_limit_configs,public.fiscal_monthly_balances to authenticated;
