-- Sprint 4: hardening de autenticação, fórmula AST, eventos fixos e simulação.
-- Aditiva. Aplicar somente após as migrações das Sprints 1, 2 e 3.

begin;

-- ---------------------------------------------------------------------------
-- HU02.06: autenticação própria endurecida
-- ---------------------------------------------------------------------------

alter table public.app_users
  add column if not exists failed_login_attempts integer not null default 0,
  add column if not exists locked_until timestamptz,
  add column if not exists last_login_at timestamptz,
  add column if not exists password_changed_at timestamptz not null default now(),
  add column if not exists force_password_change boolean not null default false;

create schema if not exists private;

create table if not exists private.auth_sessions (
  id uuid primary key,
  user_id uuid not null,
  issued_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_hash text,
  user_agent text,
  constraint auth_sessions_validity_check check (expires_at > issued_at),
  constraint auth_sessions_ip_hash_check check (
    ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'
  )
);

create index if not exists auth_sessions_user_active_idx
  on private.auth_sessions (user_id, expires_at desc)
  where revoked_at is null;

create table if not exists private.auth_login_attempts (
  id bigint generated always as identity primary key,
  identifier_hash text not null,
  ip_hash text not null,
  succeeded boolean not null default false,
  attempted_at timestamptz not null default now(),
  constraint auth_login_identifier_hash_check check (identifier_hash ~ '^[0-9a-f]{64}$'),
  constraint auth_login_ip_hash_check check (ip_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists auth_login_attempts_throttle_idx
  on private.auth_login_attempts (identifier_hash, ip_hash, attempted_at desc)
  where not succeeded;

revoke all on schema private from public;
revoke all on all tables in schema private from public;

-- ---------------------------------------------------------------------------
-- Permissões da folha
-- ---------------------------------------------------------------------------

insert into public.security_permissions (codigo, modulo, nome, criticidade)
values
  ('payroll.assignments.read','folha','Consultar rubricas fixas por vínculo','sensivel'),
  ('payroll.assignments.manage','folha','Gerenciar rubricas fixas por vínculo','critica'),
  ('payroll.simulate','folha','Executar e consultar simulações da folha','critica')
on conflict (codigo) do update set
  modulo=excluded.modulo, nome=excluded.nome, criticidade=excluded.criticidade;

insert into public.security_role_permissions (role_id, permission_id)
select role.id, permission.id
from public.security_roles role
join public.security_permissions permission on permission.codigo in (
  'payroll.assignments.read','payroll.assignments.manage','payroll.simulate'
)
where role.codigo in ('tenant_admin','sector_manager')
on conflict do nothing;

insert into public.security_role_permissions (role_id, permission_id)
select role.id, permission.id
from public.security_roles role
join public.security_permissions permission on permission.codigo in (
  'payroll.assignments.read','payroll.simulate'
)
where role.codigo = 'auditor'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- HU04.03: integridade e imutabilidade da fórmula publicada
-- ---------------------------------------------------------------------------

create or replace function public.validate_published_payroll_formula()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'publicada' then
    if new.formula_ast is null or jsonb_typeof(new.formula_ast) <> 'object' then
      raise exception 'Versão publicada exige fórmula AST válida';
    end if;
    if new.formula_checksum is null or new.formula_checksum !~ '^[0-9a-f]{64}$' then
      raise exception 'Versão publicada exige checksum SHA-256 da fórmula';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.status = 'publicada' and (
    new.rubric_id is distinct from old.rubric_id
    or new.valid_from is distinct from old.valid_from
    or new.valid_to is distinct from old.valid_to
    or new.formula_ast is distinct from old.formula_ast
    or new.formula_checksum is distinct from old.formula_checksum
    or new.rounding_scale is distinct from old.rounding_scale
    or new.rounding_mode is distinct from old.rounding_mode
  ) then
    raise exception 'Versão publicada é imutável; crie uma nova versão';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_published_payroll_formula
  on public.payroll_rubric_versions;
create trigger trg_validate_published_payroll_formula
  before insert or update on public.payroll_rubric_versions
  for each row execute function public.validate_published_payroll_formula();

-- ---------------------------------------------------------------------------
-- HU04.05: rubricas fixas por vínculo
-- ---------------------------------------------------------------------------

create table if not exists public.employment_link_rubrics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  rubric_id uuid not null references public.payroll_rubrics(id) on delete restrict,
  valid_from date not null,
  valid_to date,
  fixed_amount numeric(16,6),
  quantity numeric(16,6),
  parameters jsonb not null default '{}'::jsonb,
  status text not null default 'ativo',
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employment_link_rubrics_validity_check
    check (valid_to is null or valid_to >= valid_from),
  constraint employment_link_rubrics_amount_check
    check (fixed_amount is null or fixed_amount >= 0),
  constraint employment_link_rubrics_quantity_check
    check (quantity is null or quantity >= 0),
  constraint employment_link_rubrics_payload_check
    check (fixed_amount is not null or quantity is not null or parameters <> '{}'::jsonb),
  constraint employment_link_rubrics_status_check
    check (status in ('ativo','inativo')),
  constraint employment_link_rubrics_parameters_check
    check (jsonb_typeof(parameters) = 'object')
);

create index if not exists employment_link_rubrics_link_validity_idx
  on public.employment_link_rubrics
    (tenant_id, employment_link_id, valid_from, valid_to)
  where status = 'ativo';

create or replace function public.validate_employment_link_rubric()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  link_tenant uuid;
  rubric_tenant uuid;
begin
  select tenant_id into link_tenant
  from public.employment_links where id = new.employment_link_id;
  select tenant_id into rubric_tenant
  from public.payroll_rubrics where id = new.rubric_id;

  if link_tenant is null or rubric_tenant is null
     or link_tenant <> new.tenant_id or rubric_tenant <> new.tenant_id then
    raise exception 'Vínculo e rubrica devem pertencer à mesma entidade';
  end if;

  if new.status = 'ativo' and exists (
    select 1 from public.employment_link_rubrics current_assignment
    where current_assignment.employment_link_id = new.employment_link_id
      and current_assignment.rubric_id = new.rubric_id
      and current_assignment.status = 'ativo'
      and current_assignment.id <> new.id
      and daterange(
        current_assignment.valid_from,
        coalesce(current_assignment.valid_to + 1, 'infinity'::date), '[)'
      ) && daterange(
        new.valid_from, coalesce(new.valid_to + 1, 'infinity'::date), '[)'
      )
  ) then
    raise exception 'A vigência da rubrica fixa se sobrepõe a outra atribuição';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_employment_link_rubric
  on public.employment_link_rubrics;
create trigger trg_validate_employment_link_rubric
  before insert or update of tenant_id, employment_link_id, rubric_id,
    valid_from, valid_to, status
  on public.employment_link_rubrics
  for each row execute function public.validate_employment_link_rubric();

drop trigger if exists trg_employment_link_rubrics_updated_at
  on public.employment_link_rubrics;
create trigger trg_employment_link_rubrics_updated_at
  before update on public.employment_link_rubrics
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- HU04.06: simulação e memória de cálculo
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_calculation_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  reference_month date not null,
  run_type text not null default 'simulacao',
  status text not null default 'processando',
  engine_version text not null,
  input_snapshot jsonb not null default '{}'::jsonb,
  input_checksum text not null,
  links_requested integer not null default 0,
  links_processed integer not null default 0,
  error_message text,
  started_by uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint payroll_runs_reference_month_check
    check (reference_month = date_trunc('month', reference_month)::date),
  constraint payroll_runs_type_check check (run_type in ('simulacao')),
  constraint payroll_runs_status_check
    check (status in ('processando','concluida','falhou')),
  constraint payroll_runs_checksum_check check (input_checksum ~ '^[0-9a-f]{64}$'),
  constraint payroll_runs_counts_check
    check (links_requested >= 0 and links_processed >= 0 and links_processed <= links_requested),
  constraint payroll_runs_completion_check check (
    (status = 'processando' and completed_at is null)
    or (status in ('concluida','falhou') and completed_at is not null)
  )
);

create index if not exists payroll_runs_tenant_reference_idx
  on public.payroll_calculation_runs (tenant_id, reference_month desc, started_at desc);

create table if not exists public.payroll_calculation_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  run_id uuid not null references public.payroll_calculation_runs(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  rubric_id uuid not null references public.payroll_rubrics(id) on delete restrict,
  version_id uuid not null references public.payroll_rubric_versions(id) on delete restrict,
  sequence integer not null,
  quantity numeric(16,6),
  calculation_base numeric(16,6),
  amount numeric(16,6) not null,
  formula_checksum text not null,
  memory jsonb not null,
  created_at timestamptz not null default now(),
  constraint payroll_items_sequence_check check (sequence >= 0),
  constraint payroll_items_checksum_check check (formula_checksum ~ '^[0-9a-f]{64}$'),
  constraint payroll_items_memory_check check (jsonb_typeof(memory) = 'object'),
  constraint payroll_items_run_link_rubric_uq unique (run_id, employment_link_id, rubric_id)
);

create index if not exists payroll_items_run_link_sequence_idx
  on public.payroll_calculation_items (run_id, employment_link_id, sequence);

create or replace function public.validate_payroll_calculation_item()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  run_tenant uuid;
  link_tenant uuid;
  rubric_tenant uuid;
  version_rubric uuid;
begin
  select tenant_id into run_tenant from public.payroll_calculation_runs where id = new.run_id;
  select tenant_id into link_tenant from public.employment_links where id = new.employment_link_id;
  select tenant_id into rubric_tenant from public.payroll_rubrics where id = new.rubric_id;
  select rubric_id into version_rubric from public.payroll_rubric_versions where id = new.version_id;
  if run_tenant is null or run_tenant <> new.tenant_id
     or link_tenant <> new.tenant_id or rubric_tenant <> new.tenant_id
     or version_rubric <> new.rubric_id then
    raise exception 'Item de cálculo contém referências de outra entidade ou versão';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_payroll_calculation_item
  on public.payroll_calculation_items;
create trigger trg_validate_payroll_calculation_item
  before insert or update on public.payroll_calculation_items
  for each row execute function public.validate_payroll_calculation_item();

-- ---------------------------------------------------------------------------
-- RLS e concessões explícitas
-- ---------------------------------------------------------------------------

alter table public.employment_link_rubrics enable row level security;
alter table public.payroll_calculation_runs enable row level security;
alter table public.payroll_calculation_items enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    drop policy if exists link_rubrics_scoped_read on public.employment_link_rubrics;
    create policy link_rubrics_scoped_read on public.employment_link_rubrics
      for select to authenticated
      using (
        private.can_access_employment_link(employment_link_id, 'payroll.assignments.read')
      );
    drop policy if exists link_rubrics_scoped_manage on public.employment_link_rubrics;
    create policy link_rubrics_scoped_manage on public.employment_link_rubrics
      for all to authenticated
      using (
        private.can_access_employment_link(employment_link_id, 'payroll.assignments.manage')
      )
      with check (
        private.can_access_employment_link(employment_link_id, 'payroll.assignments.manage')
      );

    drop policy if exists payroll_runs_tenant_read on public.payroll_calculation_runs;
    create policy payroll_runs_tenant_read on public.payroll_calculation_runs
      for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.simulate'));
    drop policy if exists payroll_runs_tenant_insert on public.payroll_calculation_runs;
    create policy payroll_runs_tenant_insert on public.payroll_calculation_runs
      for insert to authenticated
      with check (private.has_tenant_permission(tenant_id, 'payroll.simulate'));

    drop policy if exists payroll_items_tenant_read on public.payroll_calculation_items;
    create policy payroll_items_tenant_read on public.payroll_calculation_items
      for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.simulate'));
    drop policy if exists payroll_items_tenant_insert on public.payroll_calculation_items;
    create policy payroll_items_tenant_insert on public.payroll_calculation_items
      for insert to authenticated
      with check (private.has_tenant_permission(tenant_id, 'payroll.simulate'));
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname='authenticated') then
    grant select,insert,update on public.employment_link_rubrics to authenticated;
    grant select,insert on public.payroll_calculation_runs to authenticated;
    grant select,insert on public.payroll_calculation_items to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant all on public.employment_link_rubrics to service_role;
    grant all on public.payroll_calculation_runs to service_role;
    grant all on public.payroll_calculation_items to service_role;
    grant usage on schema private to service_role;
    grant all on all tables in schema private to service_role;
  end if;
end $$;

commit;
