-- O1-03f — Banco de horas persistente (saldo acumulado do ponto apurado).
--
-- A apuracao (O1-03e) e o resumo mensal (O1-03g) calculam o saldo do mes
-- (extras - faltas) pontualmente, mas nada guardava o saldo ACUMULADO ao longo
-- das competencias. Esta migration cria o razao do banco de horas: uma entrada
-- por vinculo e competencia, com o saldo do mes (minutes, com sinal) e o saldo
-- acumulado apos a competencia (balance_after). O saldo acumulado e recalculado
-- pelo servidor a cada lancamento, em ordem de competencia (fonte unica: a
-- funcao postTimeBankEntry), de modo que lancar/retificar uma competencia no
-- meio reordena os saldos seguintes de forma consistente.
--
-- ESCOPO: e um razao gerencial do saldo. Compensacao efetiva (folga, pagamento
-- como extra na folha) segue pela via da folha (O1-04b); aqui fica o saldo.
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.time_bank_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  reference_month date not null,
  minutes integer not null,
  balance_after integer not null,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_bank_entries_month_day_check check (extract(day from reference_month) = 1),
  constraint time_bank_entries_minutes_range check (minutes between -1000000 and 1000000),
  constraint time_bank_entries_uq unique (tenant_id, employment_link_id, reference_month)
);

create index if not exists time_bank_entries_link_idx
  on public.time_bank_entries (tenant_id, employment_link_id, reference_month);

-- Coerencia: a entrada pertence a um vinculo da mesma entidade.
create or replace function public.validate_time_bank_entry()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  link_tenant uuid;
begin
  select tenant_id into link_tenant from public.employment_links where id = new.employment_link_id;
  if link_tenant is null or link_tenant <> new.tenant_id then
    raise exception 'O vinculo do banco de horas deve pertencer a mesma entidade';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_time_bank_entry on public.time_bank_entries;
create trigger trg_validate_time_bank_entry
  before insert or update on public.time_bank_entries
  for each row execute function public.validate_time_bank_entry();

alter table public.time_bank_entries enable row level security;

-- Politicas so no ambiente Supabase (auth.*). Leitura por people.read, lancamento
-- e retificacao por people.manage. Sem delete (o razao nao apaga; retifica-se com
-- novo valor da competencia).
do $$
begin
  if to_regnamespace('auth') is not null then
    create policy time_bank_entries_read on public.time_bank_entries for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.read'));
    create policy time_bank_entries_insert on public.time_bank_entries for insert to authenticated
      with check (private.has_tenant_permission(tenant_id, 'people.manage'));
    create policy time_bank_entries_update on public.time_bank_entries for update to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.manage'))
      with check (private.has_tenant_permission(tenant_id, 'people.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.time_bank_entries to authenticated;
  end if;
end
$$;

commit;
