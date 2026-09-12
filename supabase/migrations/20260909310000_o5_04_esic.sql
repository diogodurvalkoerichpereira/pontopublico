-- O5-04 (Onda 5 — Apoio e controle) — e-SIC: pedidos de acesso à informação (LAI,
-- Lei 12.527/2011). O cidadão pede informação; o ente responde em até 20 dias,
-- prorrogáveis por mais 10 (art. 11). Numeração sequencial por ano, prazo calculado
-- e o ciclo recebido→(prorrogado)→respondido/indeferido. Reusa protocol.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.esic_counters (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ano integer not null,
  last_numero bigint not null default 0,
  primary key (tenant_id, ano)
);

create table if not exists public.esic_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ano integer not null,
  numero bigint not null,
  solicitante text not null,
  anonimo boolean not null default false,
  pedido text not null,
  status text not null default 'recebido',
  prazo_resposta date not null,
  prorrogado boolean not null default false,
  resposta text,
  respondido_em date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint esic_ano_check check (ano between 2000 and 2200),
  constraint esic_status_check check (status in ('recebido', 'prorrogado', 'respondido', 'indeferido')),
  constraint esic_pedido_not_blank check (btrim(pedido) <> ''),
  unique (tenant_id, ano, numero)
);

create index if not exists esic_requests_ano_idx
  on public.esic_requests (tenant_id, ano);

alter table public.esic_requests enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy esic_read on public.esic_requests for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.read'));
    create policy esic_manage on public.esic_requests for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.manage'))
      with check (private.has_tenant_permission(tenant_id, 'protocol.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.esic_requests to authenticated;
  end if;
end
$$;

commit;
