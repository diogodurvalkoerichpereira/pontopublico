-- O5-01 (Onda 5 — Apoio e controle) — Protocolo / processo eletrônico. Processos
-- administrativos com numeração sequencial por ente/ano e tramitação entre
-- unidades (histórico de movimentações com despacho). Base para o controle
-- interno e a transparência.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

insert into public.security_permissions (codigo, modulo, nome, criticidade)
values
  ('protocol.read', 'protocolo', 'Consultar processos', 'sensivel'),
  ('protocol.manage', 'protocolo', 'Abrir e tramitar processos', 'sensivel')
on conflict (codigo) do update set nome = excluded.nome;

insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on p.codigo in ('protocol.read', 'protocol.manage')
where r.codigo = 'tenant_admin'
on conflict do nothing;

create table if not exists public.protocol_counters (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ano integer not null,
  last_numero bigint not null default 0,
  primary key (tenant_id, ano)
);

create table if not exists public.protocol_processes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ano integer not null,
  numero bigint not null,
  assunto text not null,
  interessado text not null,
  unidade_atual_id uuid references public.unidades(id) on delete set null,
  status text not null default 'em_tramitacao',
  aberto_em date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint protocol_ano_check check (ano between 2000 and 2200),
  constraint protocol_status_check check (status in ('em_tramitacao', 'arquivado', 'concluido')),
  constraint protocol_assunto_not_blank check (btrim(assunto) <> ''),
  unique (tenant_id, ano, numero)
);

create table if not exists public.protocol_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  process_id uuid not null references public.protocol_processes(id) on delete cascade,
  unidade_origem_id uuid references public.unidades(id) on delete set null,
  unidade_destino_id uuid references public.unidades(id) on delete set null,
  despacho text not null,
  data_movimento timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  constraint protocol_mov_despacho_not_blank check (btrim(despacho) <> '')
);

create index if not exists protocol_processes_ano_idx
  on public.protocol_processes (tenant_id, ano);
create index if not exists protocol_movements_process_idx
  on public.protocol_movements (process_id);

create or replace function public.validate_protocol_movement() returns trigger language plpgsql set search_path=public as $$
declare pt uuid;
begin
  select tenant_id into pt from public.protocol_processes where id=new.process_id;
  if pt is null or pt<>new.tenant_id then
    raise exception 'Movimentacao de processo de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_protocol_movement before insert or update on public.protocol_movements
  for each row execute function public.validate_protocol_movement();

alter table public.protocol_processes enable row level security;
alter table public.protocol_movements enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy protocol_process_read on public.protocol_processes for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.read'));
    create policy protocol_process_manage on public.protocol_processes for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.manage'))
      with check (private.has_tenant_permission(tenant_id, 'protocol.manage'));
    create policy protocol_mov_read on public.protocol_movements for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.read'));
    create policy protocol_mov_manage on public.protocol_movements for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'protocol.manage'))
      with check (private.has_tenant_permission(tenant_id, 'protocol.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.protocol_processes to authenticated;
    grant select, insert, update on public.protocol_movements to authenticated;
  end if;
end
$$;

commit;
