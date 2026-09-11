-- O3-07 (Onda 3 — Contratações) — Termo aditivo de contrato (Lei 14.133/2021,
-- art. 125). O aditivo altera o contrato: acréscimo/supressão de valor (limitado a
-- 25% do valor ORIGINAL, de forma acumulada) e/ou prorrogação de vigência. Cada
-- aditivo tem número sequencial por contrato e justificativa. Reusa contracts.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.contract_amendments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  contract_id uuid not null references public.procurement_contracts(id) on delete restrict,
  numero integer not null,
  tipo text not null,
  valor_acrescimo numeric(16,2) not null default 0,
  nova_vigencia_fim date,
  justificativa text not null,
  data_aditivo date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint amendment_numero_pos check (numero >= 1),
  constraint amendment_tipo_check check (tipo in ('valor', 'prazo', 'valor_prazo')),
  constraint amendment_justificativa_not_blank check (btrim(justificativa) <> ''),
  unique (contract_id, numero)
);

create index if not exists contract_amendments_contract_idx
  on public.contract_amendments (contract_id);

-- Coerência de ente: o contrato aditado é da mesma entidade do aditivo.
create or replace function public.validate_contract_amendment() returns trigger language plpgsql set search_path=public as $$
declare ct uuid;
begin
  select tenant_id into ct from public.procurement_contracts where id=new.contract_id;
  if ct is null or ct<>new.tenant_id then
    raise exception 'Aditivo de contrato de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_contract_amendment before insert or update on public.contract_amendments
  for each row execute function public.validate_contract_amendment();

alter table public.contract_amendments enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy amendment_read on public.contract_amendments for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.read'));
    create policy amendment_manage on public.contract_amendments for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.manage'))
      with check (private.has_tenant_permission(tenant_id, 'contracts.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.contract_amendments to authenticated;
  end if;
end
$$;

commit;
