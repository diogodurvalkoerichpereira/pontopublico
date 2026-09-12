-- O2-16 (Onda 2 — núcleo SIAFIC) — Ordem bancária (OB). Documento que autoriza e
-- executa o pagamento de um empenho liquidado (Lei 4.320 — só o liquidado paga) por
-- uma conta de tesouraria: gera a saída bancária, transiciona o empenho para 'pago' e
-- contabiliza o evento de pagamento, tudo na mesma transação. Reusa accounting.*
-- (mesma alçada da tesouraria). Numeração sequencial por ente/exercício.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.bank_order_counters (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  last_numero bigint not null default 0,
  primary key (tenant_id, exercicio)
);

create table if not exists public.bank_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  numero bigint not null,
  commitment_id uuid not null references public.budget_commitments(id) on delete restrict,
  account_id uuid not null references public.treasury_accounts(id) on delete restrict,
  movement_id uuid references public.treasury_movements(id) on delete set null,
  credor text not null,
  valor numeric(16,2) not null check (valor > 0),
  data_emissao date not null,
  historico text,
  status text not null default 'paga' check (status in ('paga', 'cancelada')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, exercicio, numero),
  unique (tenant_id, commitment_id)
);

create index if not exists bank_orders_account_idx
  on public.bank_orders (account_id, data_emissao);

-- Coerência de ente: o empenho e a conta pagos são da mesma entidade da OB.
create or replace function public.validate_bank_order() returns trigger language plpgsql set search_path=public as $$
declare ct uuid; at uuid;
begin
  select tenant_id into ct from public.budget_commitments where id=new.commitment_id;
  if ct is null or ct<>new.tenant_id then
    raise exception 'Ordem bancaria de empenho de outra entidade';
  end if;
  select tenant_id into at from public.treasury_accounts where id=new.account_id;
  if at is null or at<>new.tenant_id then
    raise exception 'Ordem bancaria de conta de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_bank_order before insert or update on public.bank_orders
  for each row execute function public.validate_bank_order();

alter table public.bank_orders enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy bank_orders_read on public.bank_orders for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.read'));
    create policy bank_orders_manage on public.bank_orders for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.manage'))
      with check (private.has_tenant_permission(tenant_id, 'accounting.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.bank_orders to authenticated;
  end if;
end
$$;

commit;
