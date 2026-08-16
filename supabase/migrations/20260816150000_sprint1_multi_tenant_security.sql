-- Sprint 1: multi-entidade, estrutura organizacional e segurança por tenant.
-- Aditiva e compatível com o legado: profiles, user_roles, rh_permissions e
-- unidades continuam existindo. Aplicar primeiro em homologação com backup.

begin;

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- EP01: entidade processável e associação usuário-entidade
-- ---------------------------------------------------------------------------

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  codigo text not null,
  nome text not null,
  cnpj text,
  timezone text not null default 'America/Sao_Paulo',
  status text not null default 'ativo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenants_codigo_not_blank check (btrim(codigo) <> ''),
  constraint tenants_nome_not_blank check (btrim(nome) <> ''),
  constraint tenants_status_check check (status in ('ativo', 'inativo'))
);

create unique index if not exists tenants_codigo_uq on public.tenants (lower(codigo));
create unique index if not exists tenants_cnpj_uq
  on public.tenants (regexp_replace(cnpj, '\D', '', 'g'))
  where cnpj is not null and btrim(cnpj) <> '';

create table if not exists public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'ativo',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_memberships_status_check check (status in ('ativo', 'suspenso', 'inativo')),
  constraint tenant_memberships_user_tenant_uq unique (tenant_id, user_id)
);

create unique index if not exists tenant_memberships_one_default_uq
  on public.tenant_memberships (user_id)
  where is_default and status = 'ativo';
create index if not exists tenant_memberships_user_idx
  on public.tenant_memberships (user_id, status);

-- ---------------------------------------------------------------------------
-- EP01: evolução não destrutiva de unidades para árvore organizacional
-- ---------------------------------------------------------------------------

alter table public.unidades add column if not exists tenant_id uuid;
alter table public.unidades add column if not exists parent_id uuid;
alter table public.unidades add column if not exists codigo text;
alter table public.unidades add column if not exists tipo text not null default 'unidade';
alter table public.unidades add column if not exists ativo boolean not null default true;
alter table public.unidades add column if not exists ordem integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'unidades_tenant_id_fkey' and conrelid = 'public.unidades'::regclass
  ) then
    alter table public.unidades
      add constraint unidades_tenant_id_fkey
      foreign key (tenant_id) references public.tenants(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'unidades_parent_id_fkey' and conrelid = 'public.unidades'::regclass
  ) then
    alter table public.unidades
      add constraint unidades_parent_id_fkey
      foreign key (parent_id) references public.unidades(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'unidades_tipo_check' and conrelid = 'public.unidades'::regclass
  ) then
    alter table public.unidades add constraint unidades_tipo_check
      check (tipo in ('entidade', 'secretaria', 'departamento', 'unidade', 'setor', 'centro_custo'));
  end if;
end $$;

create unique index if not exists unidades_tenant_codigo_uq
  on public.unidades (tenant_id, lower(codigo));
create index if not exists unidades_tenant_parent_idx
  on public.unidades (tenant_id, parent_id, ordem, nome);

create or replace function public.validate_unidade_tree()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_tenant uuid;
  cycle_found boolean;
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'Uma unidade não pode ser pai de si mesma';
  end if;

  select tenant_id into parent_tenant from public.unidades where id = new.parent_id;
  if parent_tenant is null or parent_tenant <> new.tenant_id then
    raise exception 'A unidade-pai deve pertencer à mesma entidade';
  end if;

  with recursive descendants as (
    select id from public.unidades where parent_id = new.id
    union all
    select u.id
      from public.unidades u
      join descendants d on u.parent_id = d.id
  )
  select exists(select 1 from descendants where id = new.parent_id) into cycle_found;

  if cycle_found then
    raise exception 'A alteração criaria um ciclo na estrutura organizacional';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_unidade_tree on public.unidades;
create trigger trg_validate_unidade_tree
  before insert or update of parent_id, tenant_id on public.unidades
  for each row execute function public.validate_unidade_tree();

-- ---------------------------------------------------------------------------
-- EP02: catálogo, papéis, atribuições, escopo e auditoria
-- ---------------------------------------------------------------------------

create table if not exists public.security_permissions (
  id uuid primary key default gen_random_uuid(),
  codigo text not null,
  modulo text not null,
  nome text not null,
  criticidade text not null default 'normal',
  created_at timestamptz not null default now(),
  constraint security_permissions_codigo_uq unique (codigo),
  constraint security_permissions_criticidade_check check (criticidade in ('normal', 'sensivel', 'critica'))
);

create table if not exists public.security_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  codigo text not null,
  nome text not null,
  descricao text,
  system_role boolean not null default false,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists security_roles_tenant_codigo_uq
  on public.security_roles (tenant_id, lower(codigo));

create table if not exists public.security_role_permissions (
  role_id uuid not null references public.security_roles(id) on delete cascade,
  permission_id uuid not null references public.security_permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table if not exists public.security_user_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null references public.security_roles(id) on delete cascade,
  valid_from date not null default current_date,
  valid_to date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint security_user_roles_validity_check check (valid_to is null or valid_to >= valid_from),
  constraint security_user_roles_uq unique (tenant_id, user_id, role_id, valid_from)
);

create index if not exists security_user_roles_access_idx
  on public.security_user_roles (tenant_id, user_id, valid_from, valid_to);

create table if not exists public.security_user_unit_scopes (
  user_role_id uuid not null references public.security_user_roles(id) on delete cascade,
  unit_id uuid not null references public.unidades(id) on delete cascade,
  include_descendants boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (user_role_id, unit_id)
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id) on delete restrict,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  resource text not null,
  record_id text,
  before_data jsonb,
  after_data jsonb,
  request_id text,
  ip inet,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_tenant_created_idx
  on public.audit_events (tenant_id, created_at desc);
create index if not exists audit_events_resource_record_idx
  on public.audit_events (resource, record_id);

-- Integridade cruzada das atribuições e escopos.
create or replace function public.validate_security_assignment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  role_tenant uuid;
  membership_exists boolean;
begin
  select tenant_id into role_tenant from public.security_roles where id = new.role_id;
  if role_tenant is null or role_tenant <> new.tenant_id then
    raise exception 'O papel deve pertencer à mesma entidade da atribuição';
  end if;
  select exists(
    select 1 from public.tenant_memberships
    where tenant_id = new.tenant_id and user_id = new.user_id and status = 'ativo'
  ) into membership_exists;
  if not membership_exists then
    raise exception 'O usuário não possui associação ativa com a entidade';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_security_assignment on public.security_user_roles;
create trigger trg_validate_security_assignment
  before insert or update of tenant_id, user_id, role_id on public.security_user_roles
  for each row execute function public.validate_security_assignment();

create or replace function public.validate_security_scope()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  assignment_tenant uuid;
  unit_tenant uuid;
begin
  select tenant_id into assignment_tenant from public.security_user_roles where id = new.user_role_id;
  select tenant_id into unit_tenant from public.unidades where id = new.unit_id;
  if assignment_tenant is null or unit_tenant is null or assignment_tenant <> unit_tenant then
    raise exception 'O escopo deve pertencer à mesma entidade do papel atribuído';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_security_scope on public.security_user_unit_scopes;
create trigger trg_validate_security_scope
  before insert or update of user_role_id, unit_id on public.security_user_unit_scopes
  for each row execute function public.validate_security_scope();

-- ---------------------------------------------------------------------------
-- Migração de dados legados para um tenant inicial
-- ---------------------------------------------------------------------------

insert into public.tenants (codigo, nome, status)
select 'DEFAULT', 'Entidade principal', 'ativo'
where not exists (select 1 from public.tenants);

update public.unidades
set tenant_id = (select id from public.tenants order by created_at, id limit 1)
where tenant_id is null;

update public.unidades
set codigo = 'UNIT-' || upper(substr(replace(id::text, '-', ''), 1, 8))
where codigo is null or btrim(codigo) = '';

alter table public.unidades alter column tenant_id set not null;
alter table public.unidades alter column codigo set not null;

insert into public.tenant_memberships (tenant_id, user_id, status, is_default)
select t.id, p.id, 'ativo', true
from public.profiles p
cross join lateral (select id from public.tenants order by created_at, id limit 1) t
on conflict (tenant_id, user_id) do nothing;

insert into public.security_permissions (codigo, modulo, nome, criticidade) values
  ('tenant.read', 'entidades', 'Consultar entidades', 'normal'),
  ('tenant.manage', 'entidades', 'Administrar entidades', 'critica'),
  ('org.read', 'organizacao', 'Consultar estrutura organizacional', 'normal'),
  ('org.manage', 'organizacao', 'Administrar estrutura organizacional', 'sensivel'),
  ('security.read', 'seguranca', 'Consultar papéis e permissões', 'sensivel'),
  ('security.manage', 'seguranca', 'Administrar papéis e atribuições', 'critica'),
  ('audit.read', 'auditoria', 'Consultar trilha de auditoria', 'sensivel')
on conflict (codigo) do update set
  modulo = excluded.modulo,
  nome = excluded.nome,
  criticidade = excluded.criticidade;

insert into public.security_roles (tenant_id, codigo, nome, descricao, system_role)
select t.id, v.codigo, v.nome, v.descricao, true
from public.tenants t
cross join (values
  ('tenant_admin', 'Administrador da entidade', 'Administração completa da entidade'),
  ('sector_manager', 'Gestor setorial', 'Gestão operacional da estrutura e das pessoas autorizadas'),
  ('auditor', 'Auditor', 'Consulta de configurações e trilhas sem alteração'),
  ('employee', 'Servidor', 'Acesso básico do colaborador')
) as v(codigo, nome, descricao)
on conflict do nothing;

-- Administrador recebe todo o catálogo.
insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on true
where r.codigo = 'tenant_admin'
on conflict do nothing;

-- Demais papéis recebem o mínimo necessário.
insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on
  (r.codigo = 'sector_manager' and p.codigo in ('tenant.read', 'org.read', 'org.manage', 'security.read'))
  or (r.codigo = 'auditor' and p.codigo in ('tenant.read', 'org.read', 'security.read', 'audit.read'))
  or (r.codigo = 'employee' and p.codigo in ('tenant.read', 'org.read'))
where r.codigo in ('sector_manager', 'auditor', 'employee')
on conflict do nothing;

-- Mapeia os papéis legados sem apagá-los.
insert into public.security_user_roles (tenant_id, user_id, role_id, valid_from)
select tm.tenant_id, tm.user_id, sr.id, current_date
from public.tenant_memberships tm
join public.security_roles sr on sr.tenant_id = tm.tenant_id
where sr.codigo = case
  when exists (select 1 from public.user_roles ur where ur.user_id = tm.user_id and ur.role::text = 'admin') then 'tenant_admin'
  when exists (select 1 from public.user_roles ur where ur.user_id = tm.user_id and ur.role::text = 'rh') then 'sector_manager'
  else 'employee'
end
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- RLS para Supabase. Em instalações com autenticação própria, o backend ainda
-- valida membership e permissão antes de cada operação.
-- ---------------------------------------------------------------------------

alter table public.tenants enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.unidades enable row level security;
alter table public.security_permissions enable row level security;
alter table public.security_roles enable row level security;
alter table public.security_role_permissions enable row level security;
alter table public.security_user_roles enable row level security;
alter table public.security_user_unit_scopes enable row level security;
alter table public.audit_events enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    execute $fn$
      create or replace function private.is_tenant_member(_tenant_id uuid)
      returns boolean language sql stable security definer
      set search_path = public, pg_temp
      as $body$
        select (select auth.uid()) is not null and exists (
          select 1 from public.tenant_memberships tm
          where tm.tenant_id = _tenant_id
            and tm.user_id = (select auth.uid())
            and tm.status = 'ativo'
        )
      $body$
    $fn$;
    execute $fn$
      create or replace function private.has_tenant_permission(_tenant_id uuid, _permission text)
      returns boolean language sql stable security definer
      set search_path = public, pg_temp
      as $body$
        select (select auth.uid()) is not null and exists (
          select 1
          from public.security_user_roles sur
          join public.security_role_permissions srp on srp.role_id = sur.role_id
          join public.security_permissions sp on sp.id = srp.permission_id
          where sur.tenant_id = _tenant_id
            and sur.user_id = (select auth.uid())
            and sur.valid_from <= current_date
            and (sur.valid_to is null or sur.valid_to >= current_date)
            and sp.codigo = _permission
        )
      $body$
    $fn$;

    revoke all on function private.is_tenant_member(uuid) from public;
    revoke all on function private.has_tenant_permission(uuid, text) from public;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      grant usage on schema private to authenticated;
      grant execute on function private.is_tenant_member(uuid) to authenticated;
      grant execute on function private.has_tenant_permission(uuid, text) to authenticated;
    end if;

    drop policy if exists tenants_member_read on public.tenants;
    create policy tenants_member_read on public.tenants for select to authenticated
      using (private.is_tenant_member(id));

    drop policy if exists memberships_read on public.tenant_memberships;
    create policy memberships_read on public.tenant_memberships for select to authenticated
      using (user_id = (select auth.uid()) or private.has_tenant_permission(tenant_id, 'security.read'));
    drop policy if exists memberships_manage on public.tenant_memberships;
    create policy memberships_manage on public.tenant_memberships for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'security.manage'))
      with check (private.has_tenant_permission(tenant_id, 'security.manage'));

    drop policy if exists unidades_tenant_read on public.unidades;
    create policy unidades_tenant_read on public.unidades for select to authenticated
      using (private.is_tenant_member(tenant_id));
    drop policy if exists unidades_tenant_manage on public.unidades;
    create policy unidades_tenant_manage on public.unidades for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'org.manage'))
      with check (private.has_tenant_permission(tenant_id, 'org.manage'));

    drop policy if exists permissions_authenticated_read on public.security_permissions;
    create policy permissions_authenticated_read on public.security_permissions for select to authenticated using (true);

    drop policy if exists roles_tenant_read on public.security_roles;
    create policy roles_tenant_read on public.security_roles for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'security.read'));
    drop policy if exists roles_tenant_manage on public.security_roles;
    create policy roles_tenant_manage on public.security_roles for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'security.manage'))
      with check (private.has_tenant_permission(tenant_id, 'security.manage'));

    drop policy if exists role_permissions_read on public.security_role_permissions;
    create policy role_permissions_read on public.security_role_permissions for select to authenticated
      using (exists (
        select 1 from public.security_roles r
        where r.id = role_id and private.has_tenant_permission(r.tenant_id, 'security.read')
      ));
    drop policy if exists role_permissions_manage on public.security_role_permissions;
    create policy role_permissions_manage on public.security_role_permissions for all to authenticated
      using (exists (
        select 1 from public.security_roles r
        where r.id = role_id and private.has_tenant_permission(r.tenant_id, 'security.manage')
      ))
      with check (exists (
        select 1 from public.security_roles r
        where r.id = role_id and private.has_tenant_permission(r.tenant_id, 'security.manage')
      ));

    drop policy if exists user_roles_tenant_read on public.security_user_roles;
    create policy user_roles_tenant_read on public.security_user_roles for select to authenticated
      using (user_id = (select auth.uid()) or private.has_tenant_permission(tenant_id, 'security.read'));
    drop policy if exists user_roles_tenant_manage on public.security_user_roles;
    create policy user_roles_tenant_manage on public.security_user_roles for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'security.manage'))
      with check (private.has_tenant_permission(tenant_id, 'security.manage'));

    drop policy if exists unit_scopes_read on public.security_user_unit_scopes;
    create policy unit_scopes_read on public.security_user_unit_scopes for select to authenticated
      using (exists (
        select 1 from public.security_user_roles sur
        where sur.id = user_role_id
          and (sur.user_id = (select auth.uid()) or private.has_tenant_permission(sur.tenant_id, 'security.read'))
      ));
    drop policy if exists unit_scopes_manage on public.security_user_unit_scopes;
    create policy unit_scopes_manage on public.security_user_unit_scopes for all to authenticated
      using (exists (
        select 1 from public.security_user_roles sur
        where sur.id = user_role_id and private.has_tenant_permission(sur.tenant_id, 'security.manage')
      ))
      with check (exists (
        select 1 from public.security_user_roles sur
        where sur.id = user_role_id and private.has_tenant_permission(sur.tenant_id, 'security.manage')
      ));

    drop policy if exists audit_tenant_read on public.audit_events;
    create policy audit_tenant_read on public.audit_events for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'audit.read'));
  end if;
end $$;

-- Exposição deliberada à Data API. O papel anon não recebe acesso.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on public.tenants, public.tenant_memberships, public.unidades,
      public.security_permissions, public.security_roles, public.security_role_permissions,
      public.security_user_roles, public.security_user_unit_scopes, public.audit_events
      to authenticated;
    grant insert, update, delete on public.tenant_memberships, public.unidades,
      public.security_roles, public.security_role_permissions,
      public.security_user_roles, public.security_user_unit_scopes
      to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.tenants, public.tenant_memberships, public.unidades,
      public.security_permissions, public.security_roles, public.security_role_permissions,
      public.security_user_roles, public.security_user_unit_scopes, public.audit_events
      to service_role;
    grant usage, select on sequence public.audit_events_id_seq to service_role;
  end if;
end $$;

-- Gatilhos de updated_at já existentes no projeto.
drop trigger if exists trg_tenants_updated on public.tenants;
create trigger trg_tenants_updated before update on public.tenants
  for each row execute function public.set_updated_at();
drop trigger if exists trg_memberships_updated on public.tenant_memberships;
create trigger trg_memberships_updated before update on public.tenant_memberships
  for each row execute function public.set_updated_at();
drop trigger if exists trg_security_roles_updated on public.security_roles;
create trigger trg_security_roles_updated before update on public.security_roles
  for each row execute function public.set_updated_at();

commit;
