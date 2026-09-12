-- O2-06 (Onda 2 — núcleo SIAFIC) — Roteiro de contabilização automática. Cada fato
-- orçamentário (empenho, anulação, liquidação, pagamento) deve gerar um lançamento
-- contábil balanceado (O2-05). QUAIS contas debitar/creditar por fato depende do
-- plano de contas PCASP do ente — por isso é CONFIGURÁVEL aqui, não fixado em
-- código (não se declara conformidade PCASP com códigos de memória; o ente informa
-- ou semeia do plano oficial). Sem mapeamento para o evento, o fato não contabiliza
-- (o razão fica a cargo do ente). Ver ADR 0001.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.accounting_event_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  event_code text not null,
  debit_account text not null,
  credit_account text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint accounting_event_code_check check (event_code in ('empenho', 'empenho_anulacao', 'liquidacao', 'pagamento')),
  constraint accounting_event_debit_check check (debit_account ~ '^[0-9.]{1,30}$'),
  constraint accounting_event_credit_check check (credit_account ~ '^[0-9.]{1,30}$'),
  unique (tenant_id, event_code)
);

alter table public.accounting_event_accounts enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy accounting_event_read on public.accounting_event_accounts for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.read'));
    create policy accounting_event_manage on public.accounting_event_accounts for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.manage'))
      with check (private.has_tenant_permission(tenant_id, 'accounting.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on public.accounting_event_accounts to authenticated;
  end if;
end
$$;

commit;
