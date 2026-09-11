-- O3-12 (Onda 3 — Contratações) — Ata de Registro de Preços (SRP, Lei 14.133 art. 82-86).
-- De uma licitação homologada de registro de preços forma-se a ata, com itens (unidade,
-- quantidade registrada e preço unitário) e vigência de até 1 ano (art. 84). As
-- contratações consomem do saldo de quantidade registrada, nunca acima. Reusa contracts.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.price_registrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  procurement_process_id uuid not null references public.procurement_processes(id) on delete restrict,
  numero text not null,
  ano integer not null,
  fornecedor text not null,
  vigencia_inicio date not null,
  vigencia_fim date not null,
  status text not null default 'vigente',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_reg_status_check check (status in ('vigente', 'encerrada', 'cancelada')),
  constraint price_reg_vigencia_check check (vigencia_fim > vigencia_inicio),
  constraint price_reg_fornecedor_not_blank check (btrim(fornecedor) <> ''),
  unique (tenant_id, ano, numero)
);

create table if not exists public.price_registration_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  registration_id uuid not null references public.price_registrations(id) on delete cascade,
  descricao text not null,
  unidade text not null,
  quantidade_registrada numeric(16,3) not null,
  quantidade_consumida numeric(16,3) not null default 0,
  preco_unitario numeric(16,4) not null,
  created_at timestamptz not null default now(),
  constraint price_item_qtd_pos check (quantidade_registrada > 0),
  constraint price_item_consumida_nonneg check (quantidade_consumida >= 0),
  constraint price_item_consumida_teto check (quantidade_consumida <= quantidade_registrada),
  constraint price_item_preco_pos check (preco_unitario > 0)
);

create index if not exists price_registration_items_registration_idx
  on public.price_registration_items (registration_id);

-- Coerência de ente: a licitação de origem é da mesma entidade da ata.
create or replace function public.validate_price_registration() returns trigger language plpgsql set search_path=public as $$
declare pt uuid;
begin
  select tenant_id into pt from public.procurement_processes where id=new.procurement_process_id;
  if pt is null or pt<>new.tenant_id then
    raise exception 'Ata de licitacao de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_price_registration before insert or update on public.price_registrations
  for each row execute function public.validate_price_registration();

alter table public.price_registrations enable row level security;
alter table public.price_registration_items enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy price_reg_read on public.price_registrations for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.read'));
    create policy price_reg_manage on public.price_registrations for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.manage'))
      with check (private.has_tenant_permission(tenant_id, 'contracts.manage'));
    create policy price_item_read on public.price_registration_items for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.read'));
    create policy price_item_manage on public.price_registration_items for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.manage'))
      with check (private.has_tenant_permission(tenant_id, 'contracts.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.price_registrations to authenticated;
    grant select, insert, update on public.price_registration_items to authenticated;
  end if;
end
$$;

commit;
