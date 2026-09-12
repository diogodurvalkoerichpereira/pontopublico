-- O2-08 (Onda 2 — núcleo SIAFIC) — Receita: previsão e arrecadação (Lei 4.320). A
-- receita prevista na LOA por natureza/fonte, e a arrecadação que a realiza. Fecha
-- o balanço orçamentário (receita × despesa). Reusa as permissões budget.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.budget_revenues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  natureza_receita text not null,
  fonte_recurso text not null,
  descricao text not null,
  valor_previsto numeric(16,2) not null,
  valor_arrecadado numeric(16,2) not null default 0,
  status text not null default 'ativa',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_revenue_exercicio_check check (exercicio between 2000 and 2200),
  constraint budget_revenue_natureza_check check (natureza_receita ~ '^[0-9.]{4,20}$'),
  constraint budget_revenue_status_check check (status in ('ativa', 'encerrada')),
  constraint budget_revenue_previsto_nonneg check (valor_previsto >= 0),
  constraint budget_revenue_arrecadado_nonneg check (valor_arrecadado >= 0),
  unique (tenant_id, exercicio, natureza_receita, fonte_recurso)
);

create table if not exists public.revenue_collections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  revenue_id uuid not null references public.budget_revenues(id) on delete restrict,
  data_arrecadacao date not null,
  valor numeric(16,2) not null,
  historico text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint revenue_collection_valor_pos check (valor > 0),
  constraint revenue_collection_hist_not_blank check (btrim(historico) <> '')
);

create index if not exists budget_revenues_exercicio_idx
  on public.budget_revenues (tenant_id, exercicio);
create index if not exists revenue_collections_revenue_idx
  on public.revenue_collections (revenue_id);

create or replace function public.validate_revenue_collection() returns trigger language plpgsql set search_path=public as $$
declare rt uuid;
begin
  select tenant_id into rt from public.budget_revenues where id=new.revenue_id;
  if rt is null or rt<>new.tenant_id then
    raise exception 'Arrecadacao de receita de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_revenue_collection before insert or update on public.revenue_collections
  for each row execute function public.validate_revenue_collection();

alter table public.budget_revenues enable row level security;
alter table public.revenue_collections enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy budget_revenue_read on public.budget_revenues for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.read'));
    create policy budget_revenue_manage on public.budget_revenues for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.manage'))
      with check (private.has_tenant_permission(tenant_id, 'budget.manage'));
    create policy revenue_collection_read on public.revenue_collections for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.read'));
    create policy revenue_collection_manage on public.revenue_collections for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.manage'))
      with check (private.has_tenant_permission(tenant_id, 'budget.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.budget_revenues to authenticated;
    grant select, insert, update on public.revenue_collections to authenticated;
  end if;
end
$$;

commit;
