-- O3-03 (Onda 3 — Patrimônio) — Bens patrimoniais e depreciação (NBC TSP / MCASP).
-- Cada bem tem valor de aquisição, vida útil, valor residual e a depreciação
-- acumulada (linear/quotas constantes). A depreciação nunca ultrapassa a base
-- depreciável (aquisição − residual). Base para o inventário e a VPD de
-- depreciação na contabilidade.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

insert into public.security_permissions (codigo, modulo, nome, criticidade)
values
  ('assets.read', 'patrimonio', 'Consultar bens patrimoniais', 'sensivel'),
  ('assets.manage', 'patrimonio', 'Gerir bens e depreciacao', 'critica')
on conflict (codigo) do update set nome = excluded.nome;

insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on p.codigo in ('assets.read', 'assets.manage')
where r.codigo = 'tenant_admin'
on conflict do nothing;

create table if not exists public.patrimony_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  tombamento text not null,
  descricao text not null,
  valor_aquisicao numeric(16,2) not null,
  valor_residual numeric(16,2) not null default 0,
  vida_util_meses integer not null,
  data_aquisicao date not null,
  meses_depreciados integer not null default 0,
  depreciacao_acumulada numeric(16,2) not null default 0,
  status text not null default 'ativo',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asset_status_check check (status in ('ativo', 'baixado')),
  constraint asset_valor_pos check (valor_aquisicao > 0),
  constraint asset_residual_nonneg check (valor_residual >= 0),
  constraint asset_residual_teto check (valor_residual <= valor_aquisicao),
  constraint asset_vida_util_pos check (vida_util_meses > 0),
  constraint asset_meses_nonneg check (meses_depreciados >= 0),
  constraint asset_deprec_nonneg check (depreciacao_acumulada >= 0),
  constraint asset_deprec_teto check (depreciacao_acumulada <= valor_aquisicao - valor_residual),
  constraint asset_tombamento_not_blank check (btrim(tombamento) <> ''),
  unique (tenant_id, tombamento)
);

create index if not exists patrimony_assets_status_idx
  on public.patrimony_assets (tenant_id, status);

alter table public.patrimony_assets enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy asset_read on public.patrimony_assets for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'assets.read'));
    create policy asset_manage on public.patrimony_assets for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'assets.manage'))
      with check (private.has_tenant_permission(tenant_id, 'assets.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.patrimony_assets to authenticated;
  end if;
end
$$;

commit;
