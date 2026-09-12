-- O3-08 (Onda 3 — Contratações) — Itens do contrato (Lei 14.133). Detalha o
-- contrato em linhas de material/serviço, cada uma com quantidade e preço
-- unitário; o valor da linha é quantidade × preço. A soma dos itens NÃO pode
-- exceder o valor total do contrato (invariante aplicacional). Numeração de linha
-- sequencial por contrato. Reusa contracts.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.contract_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  contract_id uuid not null references public.procurement_contracts(id) on delete restrict,
  numero integer not null,
  descricao text not null,
  unidade text not null,
  quantidade numeric(16,4) not null,
  preco_unitario numeric(16,4) not null,
  valor_total numeric(16,2) not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint contract_item_numero_pos check (numero >= 1),
  constraint contract_item_qtd_pos check (quantidade > 0),
  constraint contract_item_preco_pos check (preco_unitario > 0),
  constraint contract_item_valor_pos check (valor_total > 0),
  constraint contract_item_descricao_not_blank check (btrim(descricao) <> ''),
  unique (contract_id, numero)
);

create index if not exists contract_items_contract_idx
  on public.contract_items (contract_id);

-- Coerência de ente: o item é do mesmo ente do contrato.
create or replace function public.validate_contract_item() returns trigger language plpgsql set search_path=public as $$
declare ct uuid;
begin
  select tenant_id into ct from public.procurement_contracts where id=new.contract_id;
  if ct is null or ct<>new.tenant_id then
    raise exception 'Item de contrato de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_contract_item before insert or update on public.contract_items
  for each row execute function public.validate_contract_item();

alter table public.contract_items enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy contract_item_read on public.contract_items for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.read'));
    create policy contract_item_manage on public.contract_items for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.manage'))
      with check (private.has_tenant_permission(tenant_id, 'contracts.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.contract_items to authenticated;
  end if;
end
$$;

commit;
