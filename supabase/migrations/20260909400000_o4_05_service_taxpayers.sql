-- O4-05 (Onda 4 — Tributação e Receita) — Cadastro mobiliário (base do ISS). Cada
-- prestador de serviço tem inscrição municipal, atividade e alíquota de ISS. O
-- lançamento do ISS por competência gera um crédito tributário (tax_credits, O4-01)
-- = base de cálculo × alíquota. Reusa taxes.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.service_taxpayers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  inscricao_municipal text not null,
  razao_social text not null,
  documento text not null,
  atividade text not null,
  aliquota_iss numeric(6,3) not null,
  status text not null default 'ativo',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_taxpayer_status_check check (status in ('ativo', 'baixado')),
  constraint service_taxpayer_aliquota_check check (aliquota_iss > 0 and aliquota_iss <= 5),
  constraint service_taxpayer_razao_not_blank check (btrim(razao_social) <> ''),
  unique (tenant_id, inscricao_municipal)
);

create index if not exists service_taxpayers_status_idx
  on public.service_taxpayers (tenant_id, status);

alter table public.service_taxpayers enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy service_taxpayer_read on public.service_taxpayers for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.read'));
    create policy service_taxpayer_manage on public.service_taxpayers for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.manage'))
      with check (private.has_tenant_permission(tenant_id, 'taxes.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.service_taxpayers to authenticated;
  end if;
end
$$;

commit;
