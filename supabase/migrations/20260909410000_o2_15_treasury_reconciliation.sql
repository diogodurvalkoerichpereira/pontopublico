-- O2-15 (Onda 2 — núcleo SIAFIC) — Conciliação bancária. Compara o saldo contábil
-- (livro) de uma conta de tesouraria com o saldo do extrato bancário em uma data,
-- registrando a diferença a conciliar. Reusa accounting.* (mesma alçada da
-- tesouraria).
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.treasury_reconciliations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  account_id uuid not null references public.treasury_accounts(id) on delete restrict,
  data_referencia date not null,
  saldo_livro numeric(16,2) not null,
  saldo_extrato numeric(16,2) not null,
  diferenca numeric(16,2) not null,
  observacao text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, account_id, data_referencia)
);

create index if not exists treasury_reconciliations_account_idx
  on public.treasury_reconciliations (account_id, data_referencia);

-- Coerência de ente: a conta conciliada é da mesma entidade.
create or replace function public.validate_treasury_reconciliation() returns trigger language plpgsql set search_path=public as $$
declare at uuid;
begin
  select tenant_id into at from public.treasury_accounts where id=new.account_id;
  if at is null or at<>new.tenant_id then
    raise exception 'Conciliacao de conta de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_treasury_reconciliation before insert or update on public.treasury_reconciliations
  for each row execute function public.validate_treasury_reconciliation();

alter table public.treasury_reconciliations enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy treasury_recon_read on public.treasury_reconciliations for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.read'));
    create policy treasury_recon_manage on public.treasury_reconciliations for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.manage'))
      with check (private.has_tenant_permission(tenant_id, 'accounting.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.treasury_reconciliations to authenticated;
  end if;
end
$$;

commit;
