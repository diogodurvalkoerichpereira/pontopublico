-- O2-13 (Onda 2 — núcleo SIAFIC) — Crédito adicional por remanejamento (Lei 4.320,
-- art. 42-43). Transfere dotação de uma classificação para outra: anula parte do
-- orçado da origem e suplementa o destino, no mesmo exercício. A origem nunca fica
-- abaixo do que já foi empenhado. Cada remanejamento fica registrado com
-- justificativa (trilha do crédito adicional). Reusa budget.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.budget_credit_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  origem_id uuid not null references public.budget_appropriations(id) on delete restrict,
  destino_id uuid not null references public.budget_appropriations(id) on delete restrict,
  valor numeric(16,2) not null,
  justificativa text not null,
  data_referencia date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint budget_credit_exercicio_check check (exercicio between 2000 and 2200),
  constraint budget_credit_valor_pos check (valor > 0),
  constraint budget_credit_distintas check (origem_id <> destino_id),
  constraint budget_credit_justificativa_not_blank check (btrim(justificativa) <> '')
);

create index if not exists budget_credit_movements_exercicio_idx
  on public.budget_credit_movements (tenant_id, exercicio);

alter table public.budget_credit_movements enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy budget_credit_read on public.budget_credit_movements for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.read'));
    create policy budget_credit_manage on public.budget_credit_movements for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.manage'))
      with check (private.has_tenant_permission(tenant_id, 'budget.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert on public.budget_credit_movements to authenticated;
  end if;
end
$$;

commit;
