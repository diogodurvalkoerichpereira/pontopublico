-- O3-02 (Onda 3 — Materiais) — Almoxarifado: catálogo de materiais e movimentação
-- de estoque (entrada/saída) com saldo. A saída nunca excede o saldo. Base para a
-- contabilização de estoques (VPD de consumo) e o inventário.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

insert into public.security_permissions (codigo, modulo, nome, criticidade)
values
  ('materials.read', 'materiais', 'Consultar almoxarifado', 'sensivel'),
  ('materials.manage', 'materiais', 'Movimentar almoxarifado', 'critica')
on conflict (codigo) do update set nome = excluded.nome;

insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on p.codigo in ('materials.read', 'materials.manage')
where r.codigo = 'tenant_admin'
on conflict do nothing;

create table if not exists public.material_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  codigo text not null,
  nome text not null,
  unidade text not null,
  saldo_quantidade numeric(16,3) not null default 0,
  saldo_valor numeric(16,2) not null default 0,
  status text not null default 'ativo',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint material_status_check check (status in ('ativo', 'inativo')),
  constraint material_saldo_qtd_nonneg check (saldo_quantidade >= 0),
  constraint material_saldo_valor_nonneg check (saldo_valor >= 0),
  constraint material_codigo_not_blank check (btrim(codigo) <> ''),
  unique (tenant_id, codigo)
);

create table if not exists public.material_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  item_id uuid not null references public.material_items(id) on delete restrict,
  tipo text not null,
  quantidade numeric(16,3) not null,
  valor_unitario numeric(16,4) not null,
  data_movimento date not null,
  historico text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint material_mov_tipo_check check (tipo in ('entrada', 'saida')),
  constraint material_mov_qtd_pos check (quantidade > 0),
  constraint material_mov_valor_nonneg check (valor_unitario >= 0)
);

create index if not exists material_movements_item_idx
  on public.material_movements (item_id);

create or replace function public.validate_material_movement() returns trigger language plpgsql set search_path=public as $$
declare it uuid;
begin
  select tenant_id into it from public.material_items where id=new.item_id;
  if it is null or it<>new.tenant_id then
    raise exception 'Movimentacao de material de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_material_movement before insert or update on public.material_movements
  for each row execute function public.validate_material_movement();

alter table public.material_items enable row level security;
alter table public.material_movements enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy material_item_read on public.material_items for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'materials.read'));
    create policy material_item_manage on public.material_items for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'materials.manage'))
      with check (private.has_tenant_permission(tenant_id, 'materials.manage'));
    create policy material_mov_read on public.material_movements for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'materials.read'));
    create policy material_mov_manage on public.material_movements for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'materials.manage'))
      with check (private.has_tenant_permission(tenant_id, 'materials.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.material_items to authenticated;
    grant select, insert, update on public.material_movements to authenticated;
  end if;
end
$$;

commit;
