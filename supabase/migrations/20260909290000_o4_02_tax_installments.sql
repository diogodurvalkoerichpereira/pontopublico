-- O4-02 (Onda 4 — Tributação e Receita) — Parcelamento de crédito tributário em
-- dívida ativa (REFIS / acordo de parcelamento, Lei 6.830 + LC do ente). Um
-- crédito em dívida ativa, com saldo devedor, pode ser parcelado: o saldo é
-- rateado em N parcelas mensais; cada parcela paga arrecada no crédito; quando
-- todas quitam, o crédito quita. Reusa as permissões de tributos (taxes.*).
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.tax_installment_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  credit_id uuid not null references public.tax_credits(id) on delete restrict,
  numero_parcelas integer not null,
  valor_total numeric(16,2) not null,
  data_acordo date not null,
  status text not null default 'ativo',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_plan_parcelas_check check (numero_parcelas between 1 and 240),
  constraint tax_plan_total_pos check (valor_total > 0),
  constraint tax_plan_status_check check (status in ('ativo', 'quitado', 'rescindido'))
);

create table if not exists public.tax_installments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  plan_id uuid not null references public.tax_installment_plans(id) on delete restrict,
  numero integer not null,
  valor numeric(16,2) not null,
  vencimento date not null,
  status text not null default 'aberta',
  paga_em date,
  created_at timestamptz not null default now(),
  constraint tax_installment_numero_pos check (numero >= 1),
  constraint tax_installment_valor_pos check (valor > 0),
  constraint tax_installment_status_check check (status in ('aberta', 'paga')),
  unique (plan_id, numero)
);

create index if not exists tax_installment_plans_credit_idx
  on public.tax_installment_plans (credit_id);
create index if not exists tax_installments_plan_idx
  on public.tax_installments (plan_id);

-- Só um plano ativo por crédito (parcelamento em vigor é exclusivo).
create unique index if not exists tax_installment_plans_um_ativo
  on public.tax_installment_plans (credit_id) where status = 'ativo';

-- Coerência de tenant: parcela e plano do mesmo ente do crédito.
create or replace function public.validate_tax_installment_plan() returns trigger language plpgsql set search_path=public as $$
declare ct uuid;
begin
  select tenant_id into ct from public.tax_credits where id=new.credit_id;
  if ct is null or ct<>new.tenant_id then
    raise exception 'Parcelamento de credito de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_tax_installment_plan before insert or update on public.tax_installment_plans
  for each row execute function public.validate_tax_installment_plan();

create or replace function public.validate_tax_installment() returns trigger language plpgsql set search_path=public as $$
declare pt uuid;
begin
  select tenant_id into pt from public.tax_installment_plans where id=new.plan_id;
  if pt is null or pt<>new.tenant_id then
    raise exception 'Parcela de plano de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_tax_installment before insert or update on public.tax_installments
  for each row execute function public.validate_tax_installment();

alter table public.tax_installment_plans enable row level security;
alter table public.tax_installments enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy tax_plan_read on public.tax_installment_plans for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.read'));
    create policy tax_plan_manage on public.tax_installment_plans for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.manage'))
      with check (private.has_tenant_permission(tenant_id, 'taxes.manage'));
    create policy tax_installment_read on public.tax_installments for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.read'));
    create policy tax_installment_manage on public.tax_installments for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.manage'))
      with check (private.has_tenant_permission(tenant_id, 'taxes.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.tax_installment_plans to authenticated;
    grant select, insert, update on public.tax_installments to authenticated;
  end if;
end
$$;

commit;
