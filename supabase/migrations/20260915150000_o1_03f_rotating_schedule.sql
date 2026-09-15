-- O1-03f (parte 3) — Escala ROTATIVA (ciclo de N dias) por vinculo.
--
-- A escala semanal (O1-03f parte 2, `employment_weekly_schedules`) repete o mesmo
-- previsto a cada semana calendario (domingo..sabado) — nao serve para turno em
-- ciclo (ex.: 12x36, escala de plantao de 6 dias). Esta migration guarda, por
-- vinculo, um ciclo de N dias ancorado numa data (`cycle_start_date` = dia 0) com
-- os minutos previstos de cada dia do ciclo (`minutes_by_day`). A apuracao usa a
-- escala rotativa quando existir, com PRECEDENCIA sobre a semanal e o padrao por
-- `weekly_hours` (rotativa > semanal > padrao) — o vinculo so tem uma das duas
-- (rotativa e semanal sao mutuamente exclusivas por escolha do RH; nada impede as
-- duas linhas existirem, mas a apuracao so consulta a rotativa quando presente).
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.employment_rotating_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  cycle_start_date date not null,
  cycle_length_days integer not null,
  minutes_by_day integer[] not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ers_link_uq unique (tenant_id, employment_link_id),
  constraint ers_length_range check (cycle_length_days between 1 and 60),
  constraint ers_minutes_length check (array_length(minutes_by_day, 1) = cycle_length_days)
);

-- Coerencia: a escala pertence a um vinculo da mesma entidade, e cada minuto do
-- ciclo esta entre 0 e 1440 (o check de array nao expressa "todo elemento" sem
-- percorrer — faz-se no trigger, junto da coerencia de tenant).
create or replace function public.validate_employment_rotating_schedule()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  link_tenant uuid;
  minuto integer;
begin
  select tenant_id into link_tenant from public.employment_links where id = new.employment_link_id;
  if link_tenant is null or link_tenant <> new.tenant_id then
    raise exception 'A escala deve pertencer a um vinculo da mesma entidade';
  end if;
  foreach minuto in array new.minutes_by_day loop
    if minuto < 0 or minuto > 1440 then
      raise exception 'Minutos previstos por dia do ciclo devem estar entre 0 e 1440';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_validate_employment_rotating_schedule on public.employment_rotating_schedules;
create trigger trg_validate_employment_rotating_schedule
  before insert or update on public.employment_rotating_schedules
  for each row execute function public.validate_employment_rotating_schedule();

alter table public.employment_rotating_schedules enable row level security;

-- Politicas so no ambiente Supabase (auth.*). Leitura por people.read, edicao por
-- people.manage — mesmo padrao da escala semanal.
do $$
begin
  if to_regnamespace('auth') is not null then
    create policy ers_read on public.employment_rotating_schedules for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.read'));
    create policy ers_insert on public.employment_rotating_schedules for insert to authenticated
      with check (private.has_tenant_permission(tenant_id, 'people.manage'));
    create policy ers_update on public.employment_rotating_schedules for update to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.manage'))
      with check (private.has_tenant_permission(tenant_id, 'people.manage'));
    create policy ers_delete on public.employment_rotating_schedules for delete to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on public.employment_rotating_schedules to authenticated;
  end if;
end
$$;

commit;
