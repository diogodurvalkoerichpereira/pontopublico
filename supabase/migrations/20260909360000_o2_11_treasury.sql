-- O2-11 (Onda 2 — núcleo SIAFIC) — Tesouraria: contas de caixa/banco do ente e a
-- movimentação financeira (ingresso, saída, transferência). O saldo da conta nunca
-- fica negativo; cada movimento grava o saldo após, para trilha. É a base do
-- balanço financeiro (Lei 4.320) e da conciliação. Reusa accounting.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.treasury_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  nome text not null,
  tipo text not null,
  banco text,
  agencia text,
  conta text,
  saldo_atual numeric(16,2) not null default 0,
  status text not null default 'ativa',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint treasury_account_tipo_check check (tipo in ('caixa', 'banco')),
  constraint treasury_account_status_check check (status in ('ativa', 'encerrada')),
  constraint treasury_account_nome_not_blank check (btrim(nome) <> ''),
  unique (tenant_id, nome)
);

create table if not exists public.treasury_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  account_id uuid not null references public.treasury_accounts(id) on delete restrict,
  tipo text not null,
  data_movimento date not null,
  valor numeric(16,2) not null,
  historico text not null,
  saldo_apos numeric(16,2) not null,
  transfer_ref uuid,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint treasury_movement_tipo_check check (tipo in ('ingresso', 'saida', 'transferencia_entrada', 'transferencia_saida')),
  constraint treasury_movement_valor_pos check (valor > 0),
  constraint treasury_movement_hist_not_blank check (btrim(historico) <> '')
);

create index if not exists treasury_movements_account_idx
  on public.treasury_movements (account_id, data_movimento);

-- Coerência de ente: o movimento é da mesma entidade da conta.
create or replace function public.validate_treasury_movement() returns trigger language plpgsql set search_path=public as $$
declare at uuid;
begin
  select tenant_id into at from public.treasury_accounts where id=new.account_id;
  if at is null or at<>new.tenant_id then
    raise exception 'Movimento de conta de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_treasury_movement before insert or update on public.treasury_movements
  for each row execute function public.validate_treasury_movement();

alter table public.treasury_accounts enable row level security;
alter table public.treasury_movements enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy treasury_account_read on public.treasury_accounts for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.read'));
    create policy treasury_account_manage on public.treasury_accounts for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.manage'))
      with check (private.has_tenant_permission(tenant_id, 'accounting.manage'));
    create policy treasury_movement_read on public.treasury_movements for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.read'));
    create policy treasury_movement_manage on public.treasury_movements for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.manage'))
      with check (private.has_tenant_permission(tenant_id, 'accounting.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.treasury_accounts to authenticated;
    grant select, insert, update on public.treasury_movements to authenticated;
  end if;
end
$$;

commit;
