-- O4-01 (Onda 4 — Tributação e Receita) — Créditos tributários: lançamento,
-- arrecadação e inscrição em dívida ativa. Cada crédito (IPTU/ISS/ITBI/taxa) tem
-- valor lançado, pago e saldo; vencido e não pago pode ser inscrito em dívida
-- ativa (Lei 6.830). A arrecadação nunca excede o saldo. É a base da receita
-- própria (liga-se à Onda 2 via arrecadação).
--
-- Aditiva. Legível, uma instrução por linha.

begin;

insert into public.security_permissions (codigo, modulo, nome, criticidade)
values
  ('taxes.read', 'tributacao', 'Consultar creditos tributarios', 'sensivel'),
  ('taxes.manage', 'tributacao', 'Lancar e arrecadar tributos', 'critica')
on conflict (codigo) do update set nome = excluded.nome;

insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on p.codigo in ('taxes.read', 'taxes.manage')
where r.codigo = 'tenant_admin'
on conflict do nothing;

create table if not exists public.tax_credits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  tributo text not null,
  exercicio integer not null,
  contribuinte text not null,
  contribuinte_documento text not null,
  inscricao text not null,
  valor_lancado numeric(16,2) not null,
  valor_pago numeric(16,2) not null default 0,
  vencimento date not null,
  status text not null default 'lancado',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_tributo_check check (tributo in ('IPTU', 'ISS', 'ITBI', 'TAXA', 'COSIP')),
  constraint tax_exercicio_check check (exercicio between 2000 and 2200),
  constraint tax_status_check check (status in ('lancado', 'divida_ativa', 'quitado', 'cancelado')),
  constraint tax_lancado_pos check (valor_lancado > 0),
  constraint tax_pago_nonneg check (valor_pago >= 0),
  constraint tax_pago_teto check (valor_pago <= valor_lancado),
  constraint tax_contribuinte_not_blank check (btrim(contribuinte) <> ''),
  unique (tenant_id, tributo, exercicio, inscricao)
);

create table if not exists public.tax_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  credit_id uuid not null references public.tax_credits(id) on delete restrict,
  data_pagamento date not null,
  valor numeric(16,2) not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tax_payment_valor_pos check (valor > 0)
);

create index if not exists tax_credits_status_idx
  on public.tax_credits (tenant_id, status);
create index if not exists tax_payments_credit_idx
  on public.tax_payments (credit_id);

create or replace function public.validate_tax_payment() returns trigger language plpgsql set search_path=public as $$
declare ct uuid;
begin
  select tenant_id into ct from public.tax_credits where id=new.credit_id;
  if ct is null or ct<>new.tenant_id then
    raise exception 'Pagamento de tributo de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_tax_payment before insert or update on public.tax_payments
  for each row execute function public.validate_tax_payment();

alter table public.tax_credits enable row level security;
alter table public.tax_payments enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy tax_credit_read on public.tax_credits for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.read'));
    create policy tax_credit_manage on public.tax_credits for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.manage'))
      with check (private.has_tenant_permission(tenant_id, 'taxes.manage'));
    create policy tax_payment_read on public.tax_payments for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.read'));
    create policy tax_payment_manage on public.tax_payments for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.manage'))
      with check (private.has_tenant_permission(tenant_id, 'taxes.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.tax_credits to authenticated;
    grant select, insert, update on public.tax_payments to authenticated;
  end if;
end
$$;

commit;
