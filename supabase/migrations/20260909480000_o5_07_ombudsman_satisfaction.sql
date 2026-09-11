-- O5-07 (Onda 5 — Transparência) — Avaliação de satisfação da ouvidoria (Lei 13.460/2017,
-- art. 23). Depois de respondida a manifestação, o cidadão avalia o atendimento (nota de
-- 1 a 5) e pode comentar. Base do indicador de satisfação dos serviços públicos. Reusa
-- protocol.*. Uma avaliação por manifestação.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.ombudsman_satisfaction (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  manifestation_id uuid not null references public.ombudsman_manifestations(id) on delete restrict,
  nota integer not null,
  comentario text,
  avaliado_em date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint ombudsman_satisfaction_nota_check check (nota between 1 and 5),
  unique (tenant_id, manifestation_id)
);

create index if not exists ombudsman_satisfaction_manifestation_idx
  on public.ombudsman_satisfaction (manifestation_id);

-- Coerência de ente: a manifestação avaliada é da mesma entidade.
create or replace function public.validate_ombudsman_satisfaction() returns trigger language plpgsql set search_path=public as $$
declare mt uuid;
begin
  select tenant_id into mt from public.ombudsman_manifestations where id=new.manifestation_id;
  if mt is null or mt<>new.tenant_id then
    raise exception 'Avaliacao de manifestacao de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_ombudsman_satisfaction before insert or update on public.ombudsman_satisfaction
  for each row execute function public.validate_ombudsman_satisfaction();

alter table public.ombudsman_satisfaction enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy ombudsman_satisfaction_read on public.ombudsman_satisfaction for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.read'));
    create policy ombudsman_satisfaction_manage on public.ombudsman_satisfaction for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.manage'))
      with check (private.has_tenant_permission(tenant_id, 'protocol.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.ombudsman_satisfaction to authenticated;
  end if;
end
$$;

commit;
