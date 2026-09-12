-- O1-03f (parte 2) — Escala semanal customizada por vinculo (jornada diaria).
--
-- Ate aqui o previsto da apuracao (O1-03e) era `weekly_hours` distribuido igual de
-- seg a sex (defaultExpectedByWeekday) — quem trabalha sabado, turno ou escala
-- diferenciada tinha o sabado como previsto 0 (todo trabalho virava extra) e uma
-- distribuicao irreal nos dias uteis. Esta migration guarda, por vinculo, os
-- minutos PREVISTOS de cada dia da semana (domingo..sabado). A apuracao usa esta
-- escala quando existir; senao, cai no padrao por `weekly_hours`.
--
-- ESCALA FIXA SEMANAL. Escala rotativa (ciclo de N dias) e um refinamento futuro.
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.employment_weekly_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  minutes_sun integer not null default 0,
  minutes_mon integer not null default 0,
  minutes_tue integer not null default 0,
  minutes_wed integer not null default 0,
  minutes_thu integer not null default 0,
  minutes_fri integer not null default 0,
  minutes_sat integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ews_sun_range check (minutes_sun between 0 and 1440),
  constraint ews_mon_range check (minutes_mon between 0 and 1440),
  constraint ews_tue_range check (minutes_tue between 0 and 1440),
  constraint ews_wed_range check (minutes_wed between 0 and 1440),
  constraint ews_thu_range check (minutes_thu between 0 and 1440),
  constraint ews_fri_range check (minutes_fri between 0 and 1440),
  constraint ews_sat_range check (minutes_sat between 0 and 1440),
  constraint ews_link_uq unique (tenant_id, employment_link_id)
);

-- Coerencia: a escala pertence a um vinculo da mesma entidade.
create or replace function public.validate_employment_weekly_schedule()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  link_tenant uuid;
begin
  select tenant_id into link_tenant from public.employment_links where id = new.employment_link_id;
  if link_tenant is null or link_tenant <> new.tenant_id then
    raise exception 'A escala deve pertencer a um vinculo da mesma entidade';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_employment_weekly_schedule on public.employment_weekly_schedules;
create trigger trg_validate_employment_weekly_schedule
  before insert or update on public.employment_weekly_schedules
  for each row execute function public.validate_employment_weekly_schedule();

alter table public.employment_weekly_schedules enable row level security;

-- Politicas so no ambiente Supabase (auth.*). Leitura por people.read, edicao por
-- people.manage.
do $$
begin
  if to_regnamespace('auth') is not null then
    create policy ews_read on public.employment_weekly_schedules for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.read'));
    create policy ews_insert on public.employment_weekly_schedules for insert to authenticated
      with check (private.has_tenant_permission(tenant_id, 'people.manage'));
    create policy ews_update on public.employment_weekly_schedules for update to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.manage'))
      with check (private.has_tenant_permission(tenant_id, 'people.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.employment_weekly_schedules to authenticated;
  end if;
end
$$;

commit;
