-- O3-11d (Onda 3 — Patrimônio) — Reavaliação de bens patrimoniais (NBC TSP).
-- A reavaliação ajusta o valor líquido contábil de um bem ativo ao seu novo valor
-- justo, sem alterar a depreciação já acumulada: valor_aquisicao passa a ser
-- novo_valor_liquido + depreciacao_acumulada, preservando a fórmula existente
-- (líquido = aquisição − depreciação acumulada) e os CHECKs de asset_deprec_teto/
-- asset_residual_teto. O histórico fica em patrimony_asset_revaluations
-- (append-only, um bem pode ser reavaliado mais de uma vez na vida útil).
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.patrimony_asset_revaluations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  asset_id uuid not null references public.patrimony_assets(id) on delete restrict,
  data_reavaliacao date not null,
  valor_liquido_anterior numeric(16,2) not null,
  valor_liquido_novo numeric(16,2) not null,
  resultado numeric(16,2) not null,
  justificativa text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint asset_reval_liquido_anterior_nonneg check (valor_liquido_anterior >= 0),
  constraint asset_reval_liquido_novo_nonneg check (valor_liquido_novo >= 0),
  constraint asset_reval_resultado_check check (resultado = valor_liquido_novo - valor_liquido_anterior),
  constraint asset_reval_justificativa_not_blank check (btrim(justificativa) <> '')
);

create index if not exists patrimony_asset_revaluations_asset_idx
  on public.patrimony_asset_revaluations (tenant_id, asset_id, data_reavaliacao);

alter table public.patrimony_asset_revaluations enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy asset_revaluation_read on public.patrimony_asset_revaluations for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'assets.read'));
    create policy asset_revaluation_insert on public.patrimony_asset_revaluations for insert to authenticated
      with check (private.has_tenant_permission(tenant_id, 'assets.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert on public.patrimony_asset_revaluations to authenticated;
  end if;
end
$$;

alter table public.accounting_event_accounts
  drop constraint if exists accounting_event_code_check;

alter table public.accounting_event_accounts
  add constraint accounting_event_code_check
  check (event_code in ('empenho', 'empenho_anulacao', 'liquidacao', 'pagamento', 'baixa_bem_depreciacao', 'baixa_bem_desincorporacao', 'baixa_bem_alienacao', 'reavaliacao_positiva', 'reavaliacao_negativa'));

commit;
