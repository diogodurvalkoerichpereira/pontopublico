-- O5-05 (Onda 5 — Apoio e controle) — Controle interno (CF art. 74, Lei 4.320 art.
-- 76-80, LRF). A unidade de controle interno registra apontamentos com recomendação,
-- responsável e prazo, e acompanha a implementação (aberto → em_implementacao →
-- implementado/nao_implementado). Numeração sequencial por ano. Reusa analytics.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.internal_control_counters (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ano integer not null,
  last_numero bigint not null default 0,
  primary key (tenant_id, ano)
);

create table if not exists public.internal_control_findings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ano integer not null,
  numero bigint not null,
  area text not null,
  descricao text not null,
  recomendacao text not null,
  responsavel text not null,
  prazo date not null,
  status text not null default 'aberto',
  providencia text,
  concluido_em date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint internal_control_ano_check check (ano between 2000 and 2200),
  constraint internal_control_status_check check (status in ('aberto', 'em_implementacao', 'implementado', 'nao_implementado')),
  constraint internal_control_descricao_not_blank check (btrim(descricao) <> ''),
  constraint internal_control_recomendacao_not_blank check (btrim(recomendacao) <> ''),
  unique (tenant_id, ano, numero)
);

create index if not exists internal_control_findings_ano_idx
  on public.internal_control_findings (tenant_id, ano);
create index if not exists internal_control_findings_status_idx
  on public.internal_control_findings (tenant_id, status);

alter table public.internal_control_findings enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy internal_control_read on public.internal_control_findings for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'analytics.read'));
    create policy internal_control_manage on public.internal_control_findings for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'analytics.manage'))
      with check (private.has_tenant_permission(tenant_id, 'analytics.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.internal_control_findings to authenticated;
  end if;
end
$$;

commit;
