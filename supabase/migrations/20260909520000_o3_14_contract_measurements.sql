-- O3-14 (Onda 3 — Contratações) — Medição / recebimento de contrato (Lei 14.133 art. 140).
-- A cada entrega de bens/serviços o ente registra uma medição do contrato, acumulando o
-- valor executado. A execução acumulada nunca ultrapassa o valor empenhado (só se
-- liquida o que foi empenhado — Lei 4.320). Numeração sequencial por contrato. Reusa
-- contracts.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

alter table public.procurement_contracts add column if not exists valor_executado numeric(16,2) not null default 0;

create table if not exists public.contract_measurements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  contract_id uuid not null references public.procurement_contracts(id) on delete restrict,
  numero integer not null,
  competencia text not null,
  valor numeric(16,2) not null,
  descricao text not null,
  data_medicao date not null,
  recebimento text not null default 'provisorio',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint contract_measurement_numero_pos check (numero >= 1),
  constraint contract_measurement_valor_pos check (valor > 0),
  constraint contract_measurement_recebimento_check check (recebimento in ('provisorio', 'definitivo')),
  constraint contract_measurement_descricao_not_blank check (btrim(descricao) <> ''),
  unique (tenant_id, contract_id, numero)
);

create index if not exists contract_measurements_contract_idx
  on public.contract_measurements (contract_id);

-- Coerência de ente: o contrato medido é da mesma entidade.
create or replace function public.validate_contract_measurement() returns trigger language plpgsql set search_path=public as $$
declare ct uuid;
begin
  select tenant_id into ct from public.procurement_contracts where id=new.contract_id;
  if ct is null or ct<>new.tenant_id then
    raise exception 'Medicao de contrato de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_contract_measurement before insert or update on public.contract_measurements
  for each row execute function public.validate_contract_measurement();

alter table public.contract_measurements enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy contract_measurement_read on public.contract_measurements for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.read'));
    create policy contract_measurement_manage on public.contract_measurements for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.manage'))
      with check (private.has_tenant_permission(tenant_id, 'contracts.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.contract_measurements to authenticated;
  end if;
end
$$;

commit;
