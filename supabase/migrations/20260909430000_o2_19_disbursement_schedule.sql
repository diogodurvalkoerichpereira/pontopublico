-- O2-19 (Onda 2 — núcleo SIAFIC) — Cronograma de desembolso / programação financeira
-- (Lei 4.320, art. 47-50). O ente programa cotas mensais de desembolso por fonte de
-- recurso; o cronograma confronta o programado com o realizado (despesa paga) mês a
-- mês. Reusa budget.* (mesma alçada do orçamento). Uma cota por ente/exercício/mês/fonte.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.disbursement_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  mes integer not null,
  fonte_recurso text not null,
  valor_programado numeric(16,2) not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint disbursement_mes_check check (mes between 1 and 12),
  constraint disbursement_exercicio_check check (exercicio between 2000 and 2200),
  constraint disbursement_programado_nonneg check (valor_programado >= 0),
  unique (tenant_id, exercicio, mes, fonte_recurso)
);

create index if not exists disbursement_schedules_exercicio_idx
  on public.disbursement_schedules (tenant_id, exercicio, mes);

alter table public.disbursement_schedules enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy disbursement_read on public.disbursement_schedules for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.read'));
    create policy disbursement_manage on public.disbursement_schedules for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.manage'))
      with check (private.has_tenant_permission(tenant_id, 'budget.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.disbursement_schedules to authenticated;
  end if;
end
$$;

commit;
