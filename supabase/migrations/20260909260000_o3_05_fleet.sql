-- O3-05 (Onda 3 — Frotas) — Veículos e eventos de frota (abastecimento e
-- manutenção). Cada evento registra o hodômetro (que nunca retrocede), litros e
-- valor. Reusa as permissões de patrimônio (assets.*), pois veículos são bens.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.fleet_vehicles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  placa text not null,
  modelo text not null,
  ano integer not null,
  odometro_atual numeric(12,1) not null default 0,
  status text not null default 'ativo',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fleet_ano_check check (ano between 1950 and 2200),
  constraint fleet_status_check check (status in ('ativo', 'manutencao', 'baixado')),
  constraint fleet_odometro_nonneg check (odometro_atual >= 0),
  constraint fleet_placa_not_blank check (btrim(placa) <> ''),
  unique (tenant_id, placa)
);

create table if not exists public.fleet_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  vehicle_id uuid not null references public.fleet_vehicles(id) on delete restrict,
  tipo text not null,
  data_evento date not null,
  odometro numeric(12,1) not null,
  litros numeric(10,3),
  valor numeric(14,2) not null,
  historico text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint fleet_event_tipo_check check (tipo in ('abastecimento', 'manutencao')),
  constraint fleet_event_odometro_nonneg check (odometro >= 0),
  constraint fleet_event_valor_nonneg check (valor >= 0),
  constraint fleet_event_litros_check check (litros is null or litros > 0)
);

create index if not exists fleet_events_vehicle_idx
  on public.fleet_events (vehicle_id);

create or replace function public.validate_fleet_event() returns trigger language plpgsql set search_path=public as $$
declare vt uuid;
begin
  select tenant_id into vt from public.fleet_vehicles where id=new.vehicle_id;
  if vt is null or vt<>new.tenant_id then
    raise exception 'Evento de frota de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_fleet_event before insert or update on public.fleet_events
  for each row execute function public.validate_fleet_event();

alter table public.fleet_vehicles enable row level security;
alter table public.fleet_events enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy fleet_vehicle_read on public.fleet_vehicles for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'assets.read'));
    create policy fleet_vehicle_manage on public.fleet_vehicles for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'assets.manage'))
      with check (private.has_tenant_permission(tenant_id, 'assets.manage'));
    create policy fleet_event_read on public.fleet_events for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'assets.read'));
    create policy fleet_event_manage on public.fleet_events for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'assets.manage'))
      with check (private.has_tenant_permission(tenant_id, 'assets.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.fleet_vehicles to authenticated;
    grant select, insert, update on public.fleet_events to authenticated;
  end if;
end
$$;

commit;
