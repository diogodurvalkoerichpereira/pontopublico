-- O4-04 (Onda 4 — Tributação e Receita) — Cadastro imobiliário (base do IPTU). Cada
-- imóvel tem inscrição imobiliária, proprietário, valor venal e áreas. O lançamento
-- do IPTU gera um crédito tributário (tax_credits, O4-01) = valor venal × alíquota,
-- ligando o cadastro à arrecadação. Reusa taxes.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.real_estate_properties (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  inscricao_imobiliaria text not null,
  proprietario text not null,
  proprietario_documento text not null,
  endereco text not null,
  valor_venal numeric(16,2) not null,
  area_terreno numeric(12,2),
  area_construida numeric(12,2),
  status text not null default 'ativo',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint real_estate_status_check check (status in ('ativo', 'baixado')),
  constraint real_estate_venal_pos check (valor_venal > 0),
  constraint real_estate_areas_nonneg check (
    (area_terreno is null or area_terreno >= 0) and
    (area_construida is null or area_construida >= 0)
  ),
  constraint real_estate_inscricao_not_blank check (btrim(inscricao_imobiliaria) <> ''),
  unique (tenant_id, inscricao_imobiliaria)
);

create index if not exists real_estate_properties_status_idx
  on public.real_estate_properties (tenant_id, status);

alter table public.real_estate_properties enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy real_estate_read on public.real_estate_properties for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.read'));
    create policy real_estate_manage on public.real_estate_properties for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.manage'))
      with check (private.has_tenant_permission(tenant_id, 'taxes.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.real_estate_properties to authenticated;
  end if;
end
$$;

commit;
