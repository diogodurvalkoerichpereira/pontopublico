-- Sprint 3: dependentes, pensionistas, movimentações funcionais,
-- catálogo/versionamento de rubricas e incidências sem ciclos.
-- Migração aditiva. Aplicar somente após as Sprints 1 e 2.

begin;

-- ---------------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------------

insert into public.security_permissions (codigo, modulo, nome, criticidade) values
  ('family.read', 'pessoas', 'Consultar dependentes e pensionistas', 'sensivel'),
  ('family.manage', 'pessoas', 'Administrar dependentes e pensionistas', 'critica'),
  ('movements.read', 'pessoas', 'Consultar movimentações funcionais', 'sensivel'),
  ('movements.manage', 'pessoas', 'Administrar movimentações funcionais', 'critica'),
  ('payroll.catalog.read', 'folha', 'Consultar catálogo de rubricas', 'sensivel'),
  ('payroll.catalog.manage', 'folha', 'Administrar rubricas, versões e incidências', 'critica')
on conflict (codigo) do update set
  modulo = excluded.modulo,
  nome = excluded.nome,
  criticidade = excluded.criticidade;

insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on
  r.codigo = 'tenant_admin'
  or (r.codigo = 'sector_manager' and p.codigo in
    ('family.read','family.manage','movements.read','movements.manage',
     'payroll.catalog.read','payroll.catalog.manage'))
  or (r.codigo = 'auditor' and p.codigo in
    ('family.read','movements.read','payroll.catalog.read'))
where p.codigo in
  ('family.read','family.manage','movements.read','movements.manage',
   'payroll.catalog.read','payroll.catalog.manage')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- EP03: dependentes e pensionistas
-- ---------------------------------------------------------------------------

create table if not exists public.person_dependents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  holder_person_id uuid not null references public.persons(id) on delete restrict,
  dependent_person_id uuid not null references public.persons(id) on delete restrict,
  relationship text not null,
  income_tax_effect boolean not null default false,
  social_security_effect boolean not null default false,
  valid_from date not null,
  valid_to date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint person_dependents_people_check check (holder_person_id <> dependent_person_id),
  constraint person_dependents_relationship_not_blank check (btrim(relationship) <> ''),
  constraint person_dependents_validity_check check (valid_to is null or valid_to >= valid_from),
  constraint person_dependents_uq unique
    (tenant_id, holder_person_id, dependent_person_id, valid_from)
);

create index if not exists person_dependents_holder_validity_idx
  on public.person_dependents (tenant_id, holder_person_id, valid_from, valid_to);

create table if not exists public.pension_beneficiaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  beneficiary_person_id uuid not null references public.persons(id) on delete restrict,
  calculation_type text not null,
  percentage numeric(7,4),
  fixed_amount numeric(14,2),
  priority integer not null default 1,
  valid_from date not null,
  valid_to date,
  legal_basis text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pension_beneficiaries_type_check check (calculation_type in ('percentual','valor_fixo')),
  constraint pension_beneficiaries_exclusive_value_check check (
    (calculation_type = 'percentual' and percentage is not null and percentage > 0 and percentage <= 100 and fixed_amount is null)
    or
    (calculation_type = 'valor_fixo' and fixed_amount is not null and fixed_amount > 0 and percentage is null)
  ),
  constraint pension_beneficiaries_priority_check check (priority > 0),
  constraint pension_beneficiaries_validity_check check (valid_to is null or valid_to >= valid_from),
  constraint pension_beneficiaries_uq unique
    (tenant_id, employment_link_id, beneficiary_person_id, valid_from)
);

create index if not exists pension_beneficiaries_link_validity_idx
  on public.pension_beneficiaries
  (tenant_id, employment_link_id, valid_from, valid_to, priority);

create or replace function public.validate_pension_beneficiary()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  link_tenant uuid;
  link_person uuid;
  allocated_percentage numeric;
begin
  select tenant_id, person_id into link_tenant, link_person
  from public.employment_links where id = new.employment_link_id;
  if link_tenant is null or link_tenant <> new.tenant_id then
    raise exception 'O vínculo de origem deve pertencer à mesma entidade';
  end if;
  if link_person = new.beneficiary_person_id then
    raise exception 'O titular não pode ser beneficiário de sua própria pensão';
  end if;
  if new.calculation_type = 'percentual' then
    select coalesce(sum(current_beneficiary.percentage), 0)
      into allocated_percentage
    from public.pension_beneficiaries current_beneficiary
    where current_beneficiary.employment_link_id = new.employment_link_id
      and current_beneficiary.calculation_type = 'percentual'
      and current_beneficiary.id <> new.id
      and daterange(current_beneficiary.valid_from,
            coalesce(current_beneficiary.valid_to + 1, 'infinity'::date), '[)')
          && daterange(new.valid_from, coalesce(new.valid_to + 1, 'infinity'::date), '[)');
    if allocated_percentage + new.percentage > 100 then
      raise exception 'O rateio percentual vigente ultrapassaria 100%%';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_pension_beneficiary on public.pension_beneficiaries;
create trigger trg_validate_pension_beneficiary
  before insert or update of tenant_id, employment_link_id, beneficiary_person_id
  on public.pension_beneficiaries
  for each row execute function public.validate_pension_beneficiary();

-- ---------------------------------------------------------------------------
-- EP03: histórico de movimentações funcionais
-- ---------------------------------------------------------------------------

create table if not exists public.employment_link_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  movement_type text not null,
  effective_date date not null,
  from_unit_id uuid references public.unidades(id) on delete restrict,
  to_unit_id uuid references public.unidades(id) on delete restrict,
  from_status text,
  to_status text,
  before_data jsonb not null default '{}'::jsonb,
  after_data jsonb not null default '{}'::jsonb,
  legal_basis text not null,
  document_path text,
  document_sha256 text,
  notes text,
  applied_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint employment_movements_type_check check (
    movement_type in ('admissao','lotacao','afastamento','cessao','retorno','desligamento')
  ),
  constraint employment_movements_status_check check (
    (from_status is null or from_status in ('rascunho','ativo','afastado','ferias','desligado'))
    and (to_status is null or to_status in ('rascunho','ativo','afastado','ferias','desligado'))
  ),
  constraint employment_movements_legal_basis_not_blank check (btrim(legal_basis) <> ''),
  constraint employment_movements_document_check check (
    (document_path is null and document_sha256 is null)
    or (document_path is not null and document_sha256 ~ '^[0-9a-fA-F]{64}$')
  )
);

create index if not exists employment_movements_link_date_idx
  on public.employment_link_movements
  (tenant_id, employment_link_id, effective_date desc, created_at desc);

create or replace function public.validate_employment_movement()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  link_tenant uuid;
  source_tenant uuid;
  target_tenant uuid;
begin
  select tenant_id into link_tenant from public.employment_links where id = new.employment_link_id;
  if link_tenant is null or link_tenant <> new.tenant_id then
    raise exception 'O vínculo deve pertencer à mesma entidade da movimentação';
  end if;
  if new.from_unit_id is not null then
    select tenant_id into source_tenant from public.unidades where id = new.from_unit_id;
    if source_tenant is null or source_tenant <> new.tenant_id then
      raise exception 'A lotação anterior deve pertencer à mesma entidade';
    end if;
  end if;
  if new.to_unit_id is not null then
    select tenant_id into target_tenant from public.unidades where id = new.to_unit_id;
    if target_tenant is null or target_tenant <> new.tenant_id then
      raise exception 'A nova lotação deve pertencer à mesma entidade';
    end if;
  end if;
  if new.movement_type = 'lotacao' and new.to_unit_id is null then
    raise exception 'Movimentação de lotação exige unidade de destino';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_employment_movement on public.employment_link_movements;
create trigger trg_validate_employment_movement
  before insert or update of tenant_id, employment_link_id, movement_type,
    from_unit_id, to_unit_id
  on public.employment_link_movements
  for each row execute function public.validate_employment_movement();

-- ---------------------------------------------------------------------------
-- EP04: catálogo, versões e incidências
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_rubrics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  code text not null,
  name text not null,
  nature text not null,
  unit text not null,
  calculation_order integer not null default 100,
  status text not null default 'rascunho',
  description text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_rubrics_code_not_blank check (btrim(code) <> ''),
  constraint payroll_rubrics_name_not_blank check (btrim(name) <> ''),
  constraint payroll_rubrics_nature_check check (nature in ('provento','desconto','informativa')),
  constraint payroll_rubrics_unit_check check (unit in ('valor','percentual','hora','dia','quantidade')),
  constraint payroll_rubrics_order_check check (calculation_order >= 0),
  constraint payroll_rubrics_status_check check (status in ('rascunho','ativo','inativo'))
);

create unique index if not exists payroll_rubrics_tenant_code_uq
  on public.payroll_rubrics (tenant_id, lower(code));
create index if not exists payroll_rubrics_tenant_order_idx
  on public.payroll_rubrics (tenant_id, calculation_order, code);

create table if not exists public.payroll_rubric_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  rubric_id uuid not null references public.payroll_rubrics(id) on delete restrict,
  version_number integer not null,
  valid_from date not null,
  valid_to date,
  status text not null default 'rascunho',
  formula_ast jsonb,
  formula_checksum text,
  rounding_scale integer not null default 2,
  rounding_mode text not null default 'half_up',
  notes text,
  published_at timestamptz,
  published_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_versions_number_check check (version_number > 0),
  constraint payroll_versions_validity_check check (valid_to is null or valid_to >= valid_from),
  constraint payroll_versions_status_check check (status in ('rascunho','publicada','arquivada')),
  constraint payroll_versions_rounding_scale_check check (rounding_scale between 0 and 6),
  constraint payroll_versions_rounding_mode_check check (rounding_mode in ('half_up','half_even','truncate')),
  constraint payroll_versions_uq unique (rubric_id, version_number)
);

create index if not exists payroll_versions_validity_idx
  on public.payroll_rubric_versions (tenant_id, rubric_id, status, valid_from, valid_to);

create or replace function public.validate_payroll_rubric_version()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  rubric_tenant uuid;
begin
  select tenant_id into rubric_tenant from public.payroll_rubrics where id = new.rubric_id;
  if rubric_tenant is null or rubric_tenant <> new.tenant_id then
    raise exception 'A rubrica deve pertencer à mesma entidade da versão';
  end if;
  if new.status = 'publicada' and exists (
    select 1 from public.payroll_rubric_versions current_version
    where current_version.rubric_id = new.rubric_id
      and current_version.status = 'publicada'
      and current_version.id <> new.id
      and daterange(current_version.valid_from, coalesce(current_version.valid_to + 1, 'infinity'::date), '[)')
          && daterange(new.valid_from, coalesce(new.valid_to + 1, 'infinity'::date), '[)')
  ) then
    raise exception 'A vigência publicada se sobrepõe a outra versão da rubrica';
  end if;
  if new.status = 'publicada' then
    new.published_at := coalesce(new.published_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_payroll_rubric_version on public.payroll_rubric_versions;
create trigger trg_validate_payroll_rubric_version
  before insert or update of tenant_id, rubric_id, valid_from, valid_to, status
  on public.payroll_rubric_versions
  for each row execute function public.validate_payroll_rubric_version();

create table if not exists public.payroll_rubric_incidences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  version_id uuid not null references public.payroll_rubric_versions(id) on delete cascade,
  base_code text,
  depends_on_rubric_id uuid references public.payroll_rubrics(id) on delete restrict,
  factor numeric(9,4) not null default 100,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint payroll_incidences_target_check check (
    (base_code is not null and depends_on_rubric_id is null)
    or (base_code is null and depends_on_rubric_id is not null)
  ),
  constraint payroll_incidences_base_check check (
    base_code is null or base_code in ('inss','irrf','fgts','patronal')
  ),
  constraint payroll_incidences_factor_check check (factor >= -1000 and factor <= 1000)
);

create unique index if not exists payroll_incidences_base_uq
  on public.payroll_rubric_incidences (version_id, base_code)
  where base_code is not null;
create unique index if not exists payroll_incidences_dependency_uq
  on public.payroll_rubric_incidences (version_id, depends_on_rubric_id)
  where depends_on_rubric_id is not null;
create index if not exists payroll_incidences_tenant_version_idx
  on public.payroll_rubric_incidences (tenant_id, version_id);

create or replace function public.validate_payroll_incidence()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  source_rubric uuid;
  source_tenant uuid;
  target_tenant uuid;
  cycle_found boolean;
begin
  select rubric_id, tenant_id into source_rubric, source_tenant
  from public.payroll_rubric_versions where id = new.version_id;
  if source_rubric is null or source_tenant <> new.tenant_id then
    raise exception 'A versão deve pertencer à mesma entidade da incidência';
  end if;
  if new.depends_on_rubric_id is null then
    return new;
  end if;
  select tenant_id into target_tenant
  from public.payroll_rubrics where id = new.depends_on_rubric_id;
  if target_tenant is null or target_tenant <> new.tenant_id then
    raise exception 'A rubrica dependente deve pertencer à mesma entidade';
  end if;
  if source_rubric = new.depends_on_rubric_id then
    raise exception 'A incidência criaria um ciclo: rubrica depende de si mesma';
  end if;

  with recursive edges as (
    select v.rubric_id as source_id, i.depends_on_rubric_id as target_id
    from public.payroll_rubric_incidences i
    join public.payroll_rubric_versions v on v.id = i.version_id
    where i.tenant_id = new.tenant_id
      and i.depends_on_rubric_id is not null
      and i.active
      and i.id <> new.id
  ), reachable as (
    select e.target_id from edges e where e.source_id = new.depends_on_rubric_id
    union
    select e.target_id from edges e join reachable r on e.source_id = r.target_id
  )
  select exists(select 1 from reachable where target_id = source_rubric)
    into cycle_found;
  if cycle_found then
    raise exception 'A incidência criaria um ciclo entre rubricas';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_payroll_incidence on public.payroll_rubric_incidences;
create trigger trg_validate_payroll_incidence
  before insert or update of tenant_id, version_id, depends_on_rubric_id, active
  on public.payroll_rubric_incidences
  for each row execute function public.validate_payroll_incidence();

create or replace function public.payroll_project_bases(_tenant_id uuid, _lines jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with line_items as (
    select version_id, amount
    from jsonb_to_recordset(coalesce(_lines, '[]'::jsonb))
      as line(version_id uuid, amount numeric)
  ), totals as (
    select incidence.base_code,
      round(sum(line.amount * incidence.factor / 100), 2) as amount
    from line_items line
    join public.payroll_rubric_incidences incidence
      on incidence.version_id = line.version_id
     and incidence.tenant_id = _tenant_id
     and incidence.active
     and incidence.base_code is not null
    group by incidence.base_code
  )
  select coalesce(jsonb_object_agg(base_code, amount), '{}'::jsonb) from totals
$$;

revoke all on function public.payroll_project_bases(uuid, jsonb) from public;

-- ---------------------------------------------------------------------------
-- Segurança RLS
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regnamespace('auth') is not null then
    execute $fn$
      create or replace function private.can_access_person_in_tenant(
        _tenant_id uuid, _person_id uuid, _permission text
      )
      returns boolean language sql stable security definer
      set search_path = public, pg_temp
      as $body$
        select (select auth.uid()) is not null and exists (
          select 1 from public.employment_links link
          where link.tenant_id = _tenant_id and link.person_id = _person_id
            and private.has_unit_permission(link.tenant_id, link.unit_id, _permission)
        )
      $body$
    $fn$;
    execute $fn$
      create or replace function private.can_access_employment_link(
        _link_id uuid, _permission text
      )
      returns boolean language sql stable security definer
      set search_path = public, pg_temp
      as $body$
        select (select auth.uid()) is not null and exists (
          select 1 from public.employment_links link
          where link.id = _link_id
            and private.has_unit_permission(link.tenant_id, link.unit_id, _permission)
        )
      $body$
    $fn$;
    revoke all on function private.can_access_person_in_tenant(uuid, uuid, text) from public;
    revoke all on function private.can_access_employment_link(uuid, text) from public;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      grant usage on schema private to authenticated;
      grant execute on function private.can_access_person_in_tenant(uuid, uuid, text) to authenticated;
      grant execute on function private.can_access_employment_link(uuid, text) to authenticated;
    end if;
  end if;
end $$;

alter table public.person_dependents enable row level security;
alter table public.pension_beneficiaries enable row level security;
alter table public.employment_link_movements enable row level security;
alter table public.payroll_rubrics enable row level security;
alter table public.payroll_rubric_versions enable row level security;
alter table public.payroll_rubric_incidences enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    drop policy if exists dependents_scoped_read on public.person_dependents;
    create policy dependents_scoped_read on public.person_dependents for select to authenticated
      using (private.can_access_person_in_tenant(tenant_id, holder_person_id, 'family.read'));
    drop policy if exists dependents_scoped_manage on public.person_dependents;
    create policy dependents_scoped_manage on public.person_dependents for all to authenticated
      using (private.can_access_person_in_tenant(tenant_id, holder_person_id, 'family.manage'))
      with check (private.can_access_person_in_tenant(tenant_id, holder_person_id, 'family.manage'));

    drop policy if exists pensions_scoped_read on public.pension_beneficiaries;
    create policy pensions_scoped_read on public.pension_beneficiaries for select to authenticated
      using (private.can_access_employment_link(employment_link_id, 'family.read'));
    drop policy if exists pensions_scoped_manage on public.pension_beneficiaries;
    create policy pensions_scoped_manage on public.pension_beneficiaries for all to authenticated
      using (private.can_access_employment_link(employment_link_id, 'family.manage'))
      with check (private.can_access_employment_link(employment_link_id, 'family.manage'));

    drop policy if exists movements_scoped_read on public.employment_link_movements;
    create policy movements_scoped_read on public.employment_link_movements for select to authenticated
      using (private.can_access_employment_link(employment_link_id, 'movements.read'));
    drop policy if exists movements_scoped_manage on public.employment_link_movements;
    create policy movements_scoped_manage on public.employment_link_movements for all to authenticated
      using (private.can_access_employment_link(employment_link_id, 'movements.manage'))
      with check (private.can_access_employment_link(employment_link_id, 'movements.manage'));

    drop policy if exists payroll_rubrics_tenant_read on public.payroll_rubrics;
    create policy payroll_rubrics_tenant_read on public.payroll_rubrics for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.catalog.read'));
    drop policy if exists payroll_rubrics_tenant_manage on public.payroll_rubrics;
    create policy payroll_rubrics_tenant_manage on public.payroll_rubrics for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.catalog.manage'))
      with check (private.has_tenant_permission(tenant_id, 'payroll.catalog.manage'));

    drop policy if exists payroll_versions_tenant_read on public.payroll_rubric_versions;
    create policy payroll_versions_tenant_read on public.payroll_rubric_versions for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.catalog.read'));
    drop policy if exists payroll_versions_tenant_manage on public.payroll_rubric_versions;
    create policy payroll_versions_tenant_manage on public.payroll_rubric_versions for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.catalog.manage'))
      with check (private.has_tenant_permission(tenant_id, 'payroll.catalog.manage'));

    drop policy if exists payroll_incidences_tenant_read on public.payroll_rubric_incidences;
    create policy payroll_incidences_tenant_read on public.payroll_rubric_incidences for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.catalog.read'));
    drop policy if exists payroll_incidences_tenant_manage on public.payroll_rubric_incidences;
    create policy payroll_incidences_tenant_manage on public.payroll_rubric_incidences for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.catalog.manage'))
      with check (private.has_tenant_permission(tenant_id, 'payroll.catalog.manage'));
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.person_dependents,
      public.pension_beneficiaries, public.employment_link_movements,
      public.payroll_rubrics, public.payroll_rubric_versions,
      public.payroll_rubric_incidences to authenticated;
    grant execute on function public.payroll_project_bases(uuid, jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.person_dependents, public.pension_beneficiaries,
      public.employment_link_movements, public.payroll_rubrics,
      public.payroll_rubric_versions, public.payroll_rubric_incidences
      to service_role;
    grant execute on function public.payroll_project_bases(uuid, jsonb) to service_role;
  end if;
end $$;

drop trigger if exists trg_person_dependents_updated on public.person_dependents;
create trigger trg_person_dependents_updated before update on public.person_dependents
  for each row execute function public.set_updated_at();
drop trigger if exists trg_pension_beneficiaries_updated on public.pension_beneficiaries;
create trigger trg_pension_beneficiaries_updated before update on public.pension_beneficiaries
  for each row execute function public.set_updated_at();
drop trigger if exists trg_payroll_rubrics_updated on public.payroll_rubrics;
create trigger trg_payroll_rubrics_updated before update on public.payroll_rubrics
  for each row execute function public.set_updated_at();
drop trigger if exists trg_payroll_versions_updated on public.payroll_rubric_versions;
create trigger trg_payroll_versions_updated before update on public.payroll_rubric_versions
  for each row execute function public.set_updated_at();

commit;
