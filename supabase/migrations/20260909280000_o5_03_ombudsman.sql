-- O5-03 (Onda 5 — Apoio e controle) — Ouvidoria. Manifestações do cidadão
-- (denúncia, reclamação, sugestão, elogio, informação) com numeração sequencial
-- por ano, prazo de resposta e o ciclo recebida→em_analise→respondida (Lei
-- 13.460/2017). Reusa as permissões de protocolo (protocol.*).
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.ombudsman_counters (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ano integer not null,
  last_numero bigint not null default 0,
  primary key (tenant_id, ano)
);

create table if not exists public.ombudsman_manifestations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ano integer not null,
  numero bigint not null,
  tipo text not null,
  canal text not null,
  anonima boolean not null default false,
  descricao text not null,
  status text not null default 'recebida',
  prazo_resposta date not null,
  resposta text,
  respondida_em date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ombudsman_ano_check check (ano between 2000 and 2200),
  constraint ombudsman_tipo_check check (tipo in ('denuncia', 'reclamacao', 'sugestao', 'elogio', 'informacao', 'solicitacao')),
  constraint ombudsman_canal_check check (canal in ('web', 'presencial', 'telefone', 'email', 'carta')),
  constraint ombudsman_status_check check (status in ('recebida', 'em_analise', 'respondida', 'arquivada')),
  constraint ombudsman_descricao_not_blank check (btrim(descricao) <> ''),
  unique (tenant_id, ano, numero)
);

create index if not exists ombudsman_manifestations_ano_idx
  on public.ombudsman_manifestations (tenant_id, ano);

alter table public.ombudsman_manifestations enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy ombudsman_read on public.ombudsman_manifestations for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.read'));
    create policy ombudsman_manage on public.ombudsman_manifestations for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.manage'))
      with check (private.has_tenant_permission(tenant_id, 'protocol.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.ombudsman_manifestations to authenticated;
  end if;
end
$$;

commit;
