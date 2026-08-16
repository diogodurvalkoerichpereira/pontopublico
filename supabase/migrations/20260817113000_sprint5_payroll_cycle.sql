-- Sprint 5 / EP05: ciclo mensal auditável da folha.
-- Aditiva. Aplicar somente após a migração da Sprint 4.

begin;

insert into public.security_permissions (codigo, modulo, nome, criticidade)
values
  ('payroll.cycles.read','folha','Consultar ciclos da folha','sensivel'),
  ('payroll.cycles.prepare','folha','Preparar prévia da folha','critica'),
  ('payroll.cycles.approve','folha','Aprovar folha conferida','critica'),
  ('payroll.cycles.close','folha','Fechar competência da folha','critica'),
  ('payroll.cycles.reopen','folha','Reabrir competência fechada','critica')
on conflict (codigo) do update set
  modulo=excluded.modulo, nome=excluded.nome, criticidade=excluded.criticidade;

insert into public.security_role_permissions (role_id, permission_id)
select role.id, permission.id
from public.security_roles role
join public.security_permissions permission on permission.codigo in (
  'payroll.cycles.read','payroll.cycles.prepare','payroll.cycles.approve',
  'payroll.cycles.close','payroll.cycles.reopen'
)
where role.codigo = 'tenant_admin'
on conflict do nothing;

insert into public.security_role_permissions (role_id, permission_id)
select role.id, permission.id
from public.security_roles role
join public.security_permissions permission on permission.codigo in (
  'payroll.cycles.read','payroll.cycles.prepare'
)
where role.codigo = 'sector_manager'
on conflict do nothing;

insert into public.security_role_permissions (role_id, permission_id)
select role.id, permission.id
from public.security_roles role
join public.security_permissions permission on permission.codigo = 'payroll.cycles.read'
where role.codigo = 'auditor'
on conflict do nothing;

create table if not exists public.payroll_cycles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  reference_month date not null,
  cycle_type text not null default 'mensal',
  sequence integer not null default 1,
  status text not null default 'previa',
  source_run_id uuid references public.payroll_calculation_runs(id) on delete restrict,
  version integer not null default 1,
  links_count integer not null default 0,
  items_count integer not null default 0,
  total_earnings numeric(18,2) not null default 0,
  total_deductions numeric(18,2) not null default 0,
  total_net numeric(18,2) not null default 0,
  prepared_by uuid references public.profiles(id) on delete restrict,
  prepared_at timestamptz not null default now(),
  review_started_by uuid references public.profiles(id) on delete restrict,
  review_started_at timestamptz,
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  closed_by uuid references public.profiles(id) on delete restrict,
  closed_at timestamptz,
  reopened_by uuid references public.profiles(id) on delete restrict,
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_cycles_month_check
    check (reference_month = date_trunc('month', reference_month)::date),
  constraint payroll_cycles_type_check check (cycle_type in ('mensal')),
  constraint payroll_cycles_sequence_check check (sequence > 0),
  constraint payroll_cycles_status_check check (
    status in ('previa','em_conferencia','aprovada','fechada','reaberta')
  ),
  constraint payroll_cycles_version_check check (version > 0),
  constraint payroll_cycles_counts_check check (links_count >= 0 and items_count >= 0),
  constraint payroll_cycles_totals_check check (
    total_earnings >= 0 and total_deductions >= 0
    and total_net = total_earnings - total_deductions
  ),
  constraint payroll_cycles_reopen_reason_check check (
    status <> 'reaberta' or length(btrim(coalesce(reopen_reason,''))) >= 10
  ),
  constraint payroll_cycles_unique unique (tenant_id, reference_month, cycle_type, sequence)
);

create index if not exists payroll_cycles_tenant_month_idx
  on public.payroll_cycles (tenant_id, reference_month desc, cycle_type, sequence desc);

create table if not exists public.payroll_cycle_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  cycle_id uuid not null references public.payroll_cycles(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  source_run_id uuid references public.payroll_calculation_runs(id) on delete restrict,
  earnings numeric(18,2) not null default 0,
  deductions numeric(18,2) not null default 0,
  informational numeric(18,2) not null default 0,
  net_amount numeric(18,2) not null default 0,
  items_count integer not null default 0,
  calculation_memory jsonb not null default '[]'::jsonb,
  result_checksum text not null,
  created_at timestamptz not null default now(),
  constraint payroll_cycle_results_values_check check (
    earnings >= 0 and deductions >= 0 and informational >= 0
    and net_amount = earnings - deductions and items_count >= 0
  ),
  constraint payroll_cycle_results_memory_check
    check (jsonb_typeof(calculation_memory) = 'array'),
  constraint payroll_cycle_results_checksum_check
    check (result_checksum ~ '^[0-9a-f]{64}$'),
  constraint payroll_cycle_results_unique unique (cycle_id, employment_link_id)
);

create index if not exists payroll_cycle_results_cycle_link_idx
  on public.payroll_cycle_results (tenant_id, cycle_id, employment_link_id);

create table if not exists public.payroll_cycle_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  cycle_id uuid not null references public.payroll_cycles(id) on delete restrict,
  from_status text,
  to_status text not null,
  reason text,
  payload jsonb not null default '{}'::jsonb,
  actor_id uuid references public.profiles(id) on delete set null,
  occurred_at timestamptz not null default now(),
  constraint payroll_cycle_events_payload_check check (jsonb_typeof(payload) = 'object')
);

create index if not exists payroll_cycle_events_timeline_idx
  on public.payroll_cycle_events (tenant_id, cycle_id, occurred_at, id);

create or replace function public.validate_payroll_cycle_references()
returns trigger
language plpgsql
set search_path = public
as $$
declare source_tenant uuid;
declare source_month date;
begin
  if new.source_run_id is not null then
    select tenant_id, reference_month into source_tenant, source_month
    from public.payroll_calculation_runs where id = new.source_run_id;
    if source_tenant is null or source_tenant <> new.tenant_id
       or source_month <> new.reference_month then
      raise exception 'A simulação deve pertencer à mesma entidade e competência';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_payroll_cycle_references on public.payroll_cycles;
create trigger trg_validate_payroll_cycle_references
  before insert or update of tenant_id, reference_month, source_run_id
  on public.payroll_cycles for each row
  execute function public.validate_payroll_cycle_references();

create or replace function public.validate_payroll_cycle_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.tenant_id <> old.tenant_id or new.reference_month <> old.reference_month
     or new.cycle_type <> old.cycle_type or new.sequence <> old.sequence then
    raise exception 'A identidade de um ciclo da folha é imutável';
  end if;
  if new.status <> old.status and not (
    (old.status = 'previa' and new.status = 'em_conferencia') or
    (old.status = 'em_conferencia' and new.status = 'aprovada') or
    (old.status = 'aprovada' and new.status = 'fechada') or
    (old.status = 'fechada' and new.status = 'reaberta') or
    (old.status = 'reaberta' and new.status = 'previa')
  ) then
    raise exception 'Transição inválida do ciclo: % -> %', old.status, new.status;
  end if;
  if new.version < old.version or new.version > old.version + 1 then
    raise exception 'Versão inválida do ciclo';
  end if;
  if new.version = old.version + 1 and not (
    old.status = 'reaberta' and new.status = 'previa'
  ) then
    raise exception 'A versão somente avança ao gerar nova prévia após reabertura';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_payroll_cycle_transition on public.payroll_cycles;
create trigger trg_validate_payroll_cycle_transition
  before update on public.payroll_cycles for each row
  execute function public.validate_payroll_cycle_transition();

create or replace function public.validate_payroll_cycle_result()
returns trigger
language plpgsql
set search_path = public
as $$
declare cycle_tenant uuid;
declare cycle_status text;
declare link_tenant uuid;
begin
  if tg_op = 'DELETE' then
    select tenant_id, status into cycle_tenant, cycle_status
    from public.payroll_cycles where id = old.cycle_id;
    if cycle_status <> 'reaberta' then
      raise exception 'Resultados somente podem ser excluídos após reabertura';
    end if;
    return old;
  end if;
  select tenant_id, status into cycle_tenant, cycle_status
  from public.payroll_cycles where id = new.cycle_id;
  select tenant_id into link_tenant
  from public.employment_links where id = new.employment_link_id;
  if cycle_tenant is null or cycle_tenant <> new.tenant_id
     or link_tenant is null or link_tenant <> new.tenant_id then
    raise exception 'Resultado contém referências de outra entidade';
  end if;
  if cycle_status not in ('previa','reaberta') then
    raise exception 'Resultados somente podem ser alterados na preparação da prévia';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_payroll_cycle_result on public.payroll_cycle_results;
create trigger trg_validate_payroll_cycle_result
  before insert or update or delete on public.payroll_cycle_results for each row
  execute function public.validate_payroll_cycle_result();

drop trigger if exists trg_payroll_cycles_updated_at on public.payroll_cycles;
create trigger trg_payroll_cycles_updated_at before update on public.payroll_cycles
for each row execute function public.set_updated_at();

alter table public.payroll_cycles enable row level security;
alter table public.payroll_cycle_results enable row level security;
alter table public.payroll_cycle_events enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy payroll_cycles_read on public.payroll_cycles for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.cycles.read'));
    create policy payroll_cycles_prepare on public.payroll_cycles for insert to authenticated
      with check (private.has_tenant_permission(tenant_id, 'payroll.cycles.prepare'));
    create policy payroll_cycles_update on public.payroll_cycles for update to authenticated
      using (
        private.has_tenant_permission(tenant_id, 'payroll.cycles.prepare') or
        private.has_tenant_permission(tenant_id, 'payroll.cycles.approve') or
        private.has_tenant_permission(tenant_id, 'payroll.cycles.close') or
        private.has_tenant_permission(tenant_id, 'payroll.cycles.reopen')
      )
      with check (
        private.has_tenant_permission(tenant_id, 'payroll.cycles.prepare') or
        private.has_tenant_permission(tenant_id, 'payroll.cycles.approve') or
        private.has_tenant_permission(tenant_id, 'payroll.cycles.close') or
        private.has_tenant_permission(tenant_id, 'payroll.cycles.reopen')
      );
    create policy payroll_cycle_results_read on public.payroll_cycle_results for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.cycles.read'));
    create policy payroll_cycle_results_prepare on public.payroll_cycle_results for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.cycles.prepare'))
      with check (private.has_tenant_permission(tenant_id, 'payroll.cycles.prepare'));
    create policy payroll_cycle_events_read on public.payroll_cycle_events for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.cycles.read'));
    create policy payroll_cycle_events_write on public.payroll_cycle_events for insert to authenticated
      with check (
        private.has_tenant_permission(tenant_id, 'payroll.cycles.prepare') or
        private.has_tenant_permission(tenant_id, 'payroll.cycles.approve') or
        private.has_tenant_permission(tenant_id, 'payroll.cycles.close') or
        private.has_tenant_permission(tenant_id, 'payroll.cycles.reopen')
      );
  end if;
end $$;

revoke all on public.payroll_cycles, public.payroll_cycle_results,
  public.payroll_cycle_events from anon;

do $$
begin
  if exists (select 1 from pg_roles where rolname='authenticated') then
    grant select,insert,update on public.payroll_cycles to authenticated;
    grant select,insert,update,delete on public.payroll_cycle_results to authenticated;
    grant select,insert on public.payroll_cycle_events to authenticated;
    grant usage,select on sequence public.payroll_cycle_events_id_seq to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant all on public.payroll_cycles, public.payroll_cycle_results,
      public.payroll_cycle_events to service_role;
    grant all on sequence public.payroll_cycle_events_id_seq to service_role;
  end if;
end $$;

commit;
