-- O5-06 (Onda 5 — Transparência) — Recurso de e-SIC (LAI Lei 12.527/2011, art. 15). Da
-- negativa de acesso (pedido indeferido) o cidadão pode recorrer à autoridade superior;
-- não provido em 1ª instância, cabe recurso de 2ª instância. Recurso provido reabre o
-- pedido para cumprimento. Reusa protocol.*. Um recurso por pedido/instância.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.esic_appeals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  request_id uuid not null references public.esic_requests(id) on delete restrict,
  instancia integer not null,
  fundamento text not null,
  data_recurso date not null,
  status text not null default 'pendente',
  decisao text,
  decidido_em date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint esic_appeal_instancia_check check (instancia in (1, 2)),
  constraint esic_appeal_status_check check (status in ('pendente', 'provido', 'improvido')),
  constraint esic_appeal_fundamento_not_blank check (btrim(fundamento) <> ''),
  unique (tenant_id, request_id, instancia)
);

create index if not exists esic_appeals_request_idx
  on public.esic_appeals (request_id);

-- Coerência de ente: o pedido recorrido é da mesma entidade.
create or replace function public.validate_esic_appeal() returns trigger language plpgsql set search_path=public as $$
declare rt uuid;
begin
  select tenant_id into rt from public.esic_requests where id=new.request_id;
  if rt is null or rt<>new.tenant_id then
    raise exception 'Recurso de pedido de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_esic_appeal before insert or update on public.esic_appeals
  for each row execute function public.validate_esic_appeal();

alter table public.esic_appeals enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy esic_appeal_read on public.esic_appeals for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.read'));
    create policy esic_appeal_manage on public.esic_appeals for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.manage'))
      with check (private.has_tenant_permission(tenant_id, 'protocol.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.esic_appeals to authenticated;
  end if;
end
$$;

commit;
