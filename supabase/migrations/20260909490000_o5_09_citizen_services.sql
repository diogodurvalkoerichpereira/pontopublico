-- O5-09 (Onda 5 — Transparência) — Carta de Serviços ao Cidadão (Lei 13.460/2017,
-- art. 7º). Catálogo dos serviços públicos oferecidos pelo ente: descrição, requisitos,
-- prazo, canais e taxa. Só um serviço completo (com descrição, prazo e canais) pode ser
-- publicado ao cidadão. Reusa protocol.*. Um serviço por nome.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.citizen_services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  nome text not null,
  descricao text not null,
  requisitos text,
  prazo_dias integer not null default 0,
  canais text,
  taxa numeric(16,2) not null default 0,
  publicado boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint citizen_service_nome_not_blank check (btrim(nome) <> ''),
  constraint citizen_service_prazo_nonneg check (prazo_dias >= 0),
  constraint citizen_service_taxa_nonneg check (taxa >= 0),
  unique (tenant_id, nome)
);

create index if not exists citizen_services_publicado_idx
  on public.citizen_services (tenant_id, publicado);

alter table public.citizen_services enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy citizen_service_read on public.citizen_services for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.read'));
    create policy citizen_service_manage on public.citizen_services for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.manage'))
      with check (private.has_tenant_permission(tenant_id, 'protocol.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.citizen_services to authenticated;
  end if;
end
$$;

commit;
