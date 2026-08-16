-- Sprint 6 / EP06: adiantamento, complementar e 13º salário.
-- Aditiva. Aplicar somente após a migração da Sprint 5.

begin;

insert into public.security_permissions (codigo, modulo, nome, criticidade)
values
  ('payroll.special.read','folha','Consultar folhas especiais','sensivel'),
  ('payroll.special.manage','folha','Preparar folhas especiais','critica')
on conflict (codigo) do update set
  modulo=excluded.modulo,nome=excluded.nome,criticidade=excluded.criticidade;

insert into public.security_role_permissions (role_id,permission_id)
select role.id,permission.id from public.security_roles role
join public.security_permissions permission
  on permission.codigo in ('payroll.special.read','payroll.special.manage')
where role.codigo='tenant_admin'
on conflict do nothing;

insert into public.security_role_permissions (role_id,permission_id)
select role.id,permission.id from public.security_roles role
join public.security_permissions permission on permission.codigo='payroll.special.read'
where role.codigo in ('sector_manager','auditor')
on conflict do nothing;

alter table public.payroll_cycles
  drop constraint if exists payroll_cycles_type_check;
alter table public.payroll_cycles
  add constraint payroll_cycles_type_check check (
    cycle_type in ('mensal','adiantamento','complementar',
      'decimo_primeira','decimo_segunda')
  );

alter table public.payroll_cycles
  add column if not exists source_cycle_id uuid
    references public.payroll_cycles(id) on delete restrict,
  add column if not exists calculation_method text,
  add column if not exists configuration jsonb not null default '{}'::jsonb;

alter table public.payroll_cycles
  add constraint payroll_cycles_method_check check (
    calculation_method is null or calculation_method in ('ultimo_salario','media_remuneratoria')
  ),
  add constraint payroll_cycles_configuration_check check (jsonb_typeof(configuration)='object'),
  add constraint payroll_cycles_special_source_check check (
    (cycle_type='complementar' and source_cycle_id is not null)
    or (cycle_type<>'complementar')
  );

create table if not exists public.payroll_special_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  cycle_id uuid not null references public.payroll_cycles(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  nature text not null,
  amount numeric(18,2) not null,
  reason text not null,
  created_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint payroll_special_adjustments_nature_check check (nature in ('provento','desconto')),
  constraint payroll_special_adjustments_amount_check check (amount>0),
  constraint payroll_special_adjustments_reason_check check (length(btrim(reason))>=5)
);

create index if not exists payroll_special_adjustments_cycle_idx
  on public.payroll_special_adjustments (tenant_id,cycle_id,employment_link_id);

create table if not exists public.payroll_advance_compensations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  advance_cycle_id uuid not null references public.payroll_cycles(id) on delete restrict,
  monthly_cycle_id uuid not null references public.payroll_cycles(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  amount numeric(18,2) not null,
  created_at timestamptz not null default now(),
  constraint payroll_advance_compensations_amount_check check (amount>0),
  constraint payroll_advance_compensations_unique unique (advance_cycle_id,employment_link_id)
);

create index if not exists payroll_advance_compensations_monthly_idx
  on public.payroll_advance_compensations (tenant_id,monthly_cycle_id,employment_link_id);

create or replace function public.validate_special_payroll_reference()
returns trigger
language plpgsql
set search_path=public
as $$
declare source_tenant uuid;
declare source_month date;
declare source_type text;
declare source_status text;
begin
  if new.source_cycle_id is not null then
    select tenant_id,reference_month,cycle_type,status
      into source_tenant,source_month,source_type,source_status
    from public.payroll_cycles where id=new.source_cycle_id;
    if source_tenant is null or source_tenant<>new.tenant_id
       or source_month<>new.reference_month then
      raise exception 'A folha de origem deve pertencer à mesma entidade e competência';
    end if;
    if new.cycle_type='complementar'
       and (source_type<>'mensal' or source_status<>'fechada') then
      raise exception 'A folha complementar exige folha mensal fechada';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_special_payroll_reference on public.payroll_cycles;
create trigger trg_validate_special_payroll_reference
  before insert or update of tenant_id,reference_month,cycle_type,source_cycle_id
  on public.payroll_cycles for each row execute function public.validate_special_payroll_reference();

create or replace function public.validate_special_adjustment()
returns trigger
language plpgsql
set search_path=public
as $$
declare cycle_tenant uuid;
declare cycle_type_value text;
declare cycle_status text;
declare link_tenant uuid;
begin
  select tenant_id,cycle_type,status into cycle_tenant,cycle_type_value,cycle_status
  from public.payroll_cycles where id=new.cycle_id;
  select tenant_id into link_tenant from public.employment_links where id=new.employment_link_id;
  if cycle_tenant is null or cycle_tenant<>new.tenant_id or link_tenant<>new.tenant_id then
    raise exception 'Ajuste contém referência de outra entidade';
  end if;
  if cycle_type_value<>'complementar' or cycle_status<>'previa' then
    raise exception 'Ajustes somente pertencem a prévia complementar';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_special_adjustment on public.payroll_special_adjustments;
create trigger trg_validate_special_adjustment
  before insert or update on public.payroll_special_adjustments for each row
  execute function public.validate_special_adjustment();

create or replace function public.validate_advance_compensation()
returns trigger
language plpgsql
set search_path=public
as $$
declare advance_tenant uuid; declare advance_type text; declare advance_status text;
declare advance_month date; declare monthly_tenant uuid; declare monthly_type text;
declare monthly_status text; declare monthly_month date; declare link_tenant uuid;
begin
  select tenant_id,cycle_type,status,reference_month
    into advance_tenant,advance_type,advance_status,advance_month
  from public.payroll_cycles where id=new.advance_cycle_id;
  select tenant_id,cycle_type,status,reference_month
    into monthly_tenant,monthly_type,monthly_status,monthly_month
  from public.payroll_cycles where id=new.monthly_cycle_id;
  select tenant_id into link_tenant from public.employment_links where id=new.employment_link_id;
  if advance_tenant<>new.tenant_id or monthly_tenant<>new.tenant_id
     or link_tenant<>new.tenant_id or advance_month<>monthly_month
     or advance_type<>'adiantamento' or advance_status<>'fechada'
     or monthly_type<>'mensal' or monthly_status not in ('previa','reaberta') then
    raise exception 'Compensação de adiantamento contém referência ou situação inválida';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_advance_compensation on public.payroll_advance_compensations;
create trigger trg_validate_advance_compensation
  before insert or update on public.payroll_advance_compensations for each row
  execute function public.validate_advance_compensation();

alter table public.payroll_special_adjustments enable row level security;
alter table public.payroll_advance_compensations enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy payroll_special_adjustments_read on public.payroll_special_adjustments
      for select to authenticated
      using (private.has_tenant_permission(tenant_id,'payroll.special.read'));
    create policy payroll_special_adjustments_manage on public.payroll_special_adjustments
      for all to authenticated
      using (private.has_tenant_permission(tenant_id,'payroll.special.manage'))
      with check (private.has_tenant_permission(tenant_id,'payroll.special.manage'));
    create policy payroll_advance_compensations_read on public.payroll_advance_compensations
      for select to authenticated
      using (
        private.has_tenant_permission(tenant_id,'payroll.cycles.read') or
        private.has_tenant_permission(tenant_id,'payroll.special.read')
      );
    create policy payroll_advance_compensations_prepare on public.payroll_advance_compensations
      for all to authenticated
      using (private.has_tenant_permission(tenant_id,'payroll.cycles.prepare'))
      with check (private.has_tenant_permission(tenant_id,'payroll.cycles.prepare'));
  end if;
end $$;

revoke all on public.payroll_special_adjustments,
  public.payroll_advance_compensations from anon;

do $$
begin
  if exists(select 1 from pg_roles where rolname='authenticated') then
    grant select,insert,update,delete on public.payroll_special_adjustments to authenticated;
    grant select,insert,update,delete on public.payroll_advance_compensations to authenticated;
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant all on public.payroll_special_adjustments,
      public.payroll_advance_compensations to service_role;
  end if;
end $$;

commit;
