-- Sprint 2: isolamento por tenant/unidade, escopos organizacionais,
-- auditoria consultável, cadastro único de pessoa e múltiplos vínculos.
-- Migração aditiva. Aplicar primeiro em homologação e reconciliar as contagens.

begin;

-- ---------------------------------------------------------------------------
-- EP02: novas permissões de RH
-- ---------------------------------------------------------------------------

insert into public.security_permissions (codigo, modulo, nome, criticidade) values
  ('people.read', 'pessoas', 'Consultar pessoas e vínculos', 'sensivel'),
  ('people.manage', 'pessoas', 'Administrar pessoas e vínculos', 'critica'),
  ('people.sensitive.read', 'pessoas', 'Consultar dados pessoais sensíveis', 'critica')
on conflict (codigo) do update set
  modulo = excluded.modulo,
  nome = excluded.nome,
  criticidade = excluded.criticidade;

insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on
  (r.codigo = 'tenant_admin')
  or (r.codigo = 'sector_manager' and p.codigo in ('people.read', 'people.manage', 'people.sensitive.read'))
  or (r.codigo = 'auditor' and p.codigo = 'people.read')
where p.codigo in ('people.read', 'people.manage', 'people.sensitive.read')
on conflict do nothing;

alter table public.security_user_roles add column if not exists revoked_at timestamptz;
alter table public.security_user_roles add column if not exists revoked_by uuid references public.profiles(id) on delete set null;

-- ---------------------------------------------------------------------------
-- EP03: pessoa global independente de login/matrícula
-- ---------------------------------------------------------------------------

create table if not exists public.persons (
  id uuid primary key default gen_random_uuid(),
  cpf text,
  full_name text not null,
  social_name text,
  birth_date date,
  mother_name text,
  personal_email text,
  phone text,
  sensitive_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint persons_name_not_blank check (btrim(full_name) <> '')
);

create unique index if not exists persons_cpf_digits_uq
  on public.persons (regexp_replace(cpf, '\D', '', 'g'))
  where cpf is not null and length(regexp_replace(cpf, '\D', '', 'g')) = 11;
create index if not exists persons_name_idx on public.persons (lower(full_name));

alter table public.profiles add column if not exists person_id uuid;

-- Um CPF válido gera uma única pessoa. Sem CPF, mantém-se uma pessoa por perfil.
with source as (
  select p.*,
    nullif(regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g'), '') as cpf_key,
    row_number() over (
      partition by coalesce(
        nullif(regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g'), ''),
        p.id::text
      )
      order by p.created_at, p.id
    ) as rn
  from public.profiles p
), canonical as (
  select * from source where rn = 1
)
insert into public.persons
  (id, cpf, full_name, birth_date, mother_name, personal_email, phone, sensitive_data, created_at, updated_at)
select
  c.id,
  case when length(c.cpf_key) = 11 then c.cpf else null end,
  coalesce(nullif(btrim(c.full_name), ''), nullif(btrim(c.email), ''), 'Pessoa sem nome'),
  c.data_nascimento,
  c.nome_mae,
  coalesce(c.email_pessoal, c.email),
  c.celular,
  jsonb_strip_nulls(jsonb_build_object(
    'rg', c.rg,
    'pis_pasep', c.pis_pasep,
    'sexo', c.sexo,
    'estado_civil', c.estado_civil,
    'endereco', jsonb_strip_nulls(jsonb_build_object(
      'cep', c.cep, 'logradouro', c.logradouro, 'numero', c.numero_endereco,
      'complemento', c.complemento, 'bairro', c.bairro,
      'cidade', c.cidade, 'uf', c.uf
    ))
  )),
  c.created_at,
  c.updated_at
from canonical c
on conflict do nothing;

update public.profiles p
set person_id = coalesce(
  (
    select pe.id
    from public.persons pe
    where length(regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g')) = 11
      and regexp_replace(pe.cpf, '\D', '', 'g') = regexp_replace(p.cpf, '\D', '', 'g')
    limit 1
  ),
  p.id
)
where p.person_id is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_person_id_fkey' and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles add constraint profiles_person_id_fkey
      foreign key (person_id) references public.persons(id) on delete restrict;
  end if;
end $$;

create index if not exists profiles_person_idx on public.profiles(person_id);

-- ---------------------------------------------------------------------------
-- EP03: vínculos funcionais independentes por tenant/matrícula
-- ---------------------------------------------------------------------------

create table if not exists public.employment_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  person_id uuid not null references public.persons(id) on delete restrict,
  source_profile_id uuid references public.profiles(id) on delete set null,
  registration_number text not null,
  unit_id uuid references public.unidades(id) on delete restrict,
  employment_type text,
  work_regime text,
  job_title text,
  function_title text,
  weekly_hours numeric(6,2),
  cost_center text,
  base_salary numeric(14,2),
  admission_date date,
  termination_date date,
  status text not null default 'rascunho',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employment_links_registration_not_blank check (btrim(registration_number) <> ''),
  constraint employment_links_status_check check (status in ('rascunho', 'ativo', 'afastado', 'ferias', 'desligado')),
  constraint employment_links_dates_check check (termination_date is null or admission_date is null or termination_date >= admission_date),
  constraint employment_links_weekly_hours_check check (weekly_hours is null or weekly_hours > 0),
  constraint employment_links_base_salary_check check (base_salary is null or base_salary >= 0)
);

create unique index if not exists employment_links_tenant_registration_uq
  on public.employment_links (tenant_id, lower(registration_number));
create index if not exists employment_links_tenant_unit_idx
  on public.employment_links (tenant_id, unit_id, status);
create index if not exists employment_links_person_idx
  on public.employment_links (person_id, tenant_id);
create unique index if not exists employment_links_legacy_source_uq
  on public.employment_links (tenant_id, source_profile_id)
  where source_profile_id is not null;

create or replace function public.validate_employment_link()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  unit_tenant uuid;
begin
  if new.unit_id is not null then
    select tenant_id into unit_tenant from public.unidades where id = new.unit_id;
    if unit_tenant is null or unit_tenant <> new.tenant_id then
      raise exception 'A lotação deve pertencer à mesma entidade do vínculo';
    end if;
  end if;

  if new.status = 'ativo' and (
    new.unit_id is null or nullif(btrim(new.employment_type), '') is null
    or nullif(btrim(new.work_regime), '') is null
    or nullif(btrim(new.job_title), '') is null
    or new.weekly_hours is null or new.admission_date is null
  ) then
    raise exception 'Vínculo ativo exige lotação, tipo, regime, cargo, jornada e admissão';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_employment_link on public.employment_links;
create trigger trg_validate_employment_link
  before insert or update of tenant_id, unit_id, status, employment_type,
    work_regime, job_title, weekly_hours, admission_date
  on public.employment_links
  for each row execute function public.validate_employment_link();

-- Reconciliação legada: um vínculo por membership, preservando o perfil de origem.
with legacy as (
  select
    tm.tenant_id,
    p.id as profile_id,
    p.person_id,
    case
      when nullif(btrim(p.matricula), '') is null then 'LEGACY-' || upper(substr(replace(p.id::text, '-', ''), 1, 8))
      when count(*) over (partition by tm.tenant_id, lower(btrim(p.matricula))) > 1
        then btrim(p.matricula) || '-' || upper(substr(replace(p.id::text, '-', ''), 1, 6))
      else btrim(p.matricula)
    end as registration_number,
    case when u.tenant_id = tm.tenant_id then p.unidade_id else null end as unit_id,
    p.tipo_contrato,
    p.regime_trabalho,
    p.cargo,
    p.jornada_semanal_horas,
    p.centro_custo,
    p.salario,
    p.data_admissao,
    p.data_demissao,
    p.status::text as legacy_status
  from public.tenant_memberships tm
  join public.profiles p on p.id = tm.user_id
  left join public.unidades u on u.id = p.unidade_id
  where tm.status = 'ativo'
)
insert into public.employment_links
  (tenant_id, person_id, source_profile_id, registration_number, unit_id,
   employment_type, work_regime, job_title, weekly_hours, cost_center,
   base_salary, admission_date, termination_date, status)
select
  l.tenant_id, l.person_id, l.profile_id, l.registration_number, l.unit_id,
  l.tipo_contrato, l.regime_trabalho, l.cargo, l.jornada_semanal_horas,
  l.centro_custo, l.salario, l.data_admissao, l.data_demissao,
  case
    when l.legacy_status = 'desligado' then 'desligado'
    when l.unit_id is not null
      and nullif(btrim(l.tipo_contrato), '') is not null
      and nullif(btrim(l.regime_trabalho), '') is not null
      and nullif(btrim(l.cargo), '') is not null
      and l.jornada_semanal_horas is not null
      and l.data_admissao is not null
      then case when l.legacy_status in ('ativo', 'afastado', 'ferias') then l.legacy_status else 'ativo' end
    else 'rascunho'
  end
from legacy l
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- EP01/EP02: escopo por unidade, descendentes e auditoria automática
-- ---------------------------------------------------------------------------

create or replace function public.scoped_unit_ids(
  _tenant_id uuid,
  _user_id uuid,
  _permission text
)
returns table(unit_id uuid)
language sql
stable
set search_path = public
as $$
  with recursive eligible_roles as (
    select sur.id
    from public.security_user_roles sur
    join public.security_roles sr on sr.id = sur.role_id and sr.ativo
    join public.security_role_permissions srp on srp.role_id = sr.id
    join public.security_permissions sp on sp.id = srp.permission_id
    where sur.tenant_id = _tenant_id
      and sur.user_id = _user_id
      and sur.valid_from <= current_date
      and (sur.valid_to is null or sur.valid_to >= current_date)
      and sur.revoked_at is null
      and sp.codigo = _permission
  ), roots as (
    select s.unit_id, s.include_descendants
    from public.security_user_unit_scopes s
    join eligible_roles er on er.id = s.user_role_id
  ), scoped as (
    select r.unit_id, r.include_descendants from roots r
    union
    select u.id, true
    from public.unidades u
    join scoped parent on parent.unit_id = u.parent_id and parent.include_descendants
    where u.tenant_id = _tenant_id
  )
  select u.id
  from public.unidades u
  where u.tenant_id = _tenant_id
    and (
      exists(select 1 from eligible_roles)
      and (
        exists(
          select 1 from eligible_roles er
          where not exists (
            select 1 from public.security_user_unit_scopes s where s.user_role_id = er.id
          )
        )
        or u.id in (select scoped.unit_id from scoped)
      )
    )
$$;

-- Acesso unitário usado nas políticas. Unidade nula só é globalmente acessível.
do $$
begin
  if to_regnamespace('auth') is not null then
    execute $fn$
      create or replace function private.has_unit_permission(
        _tenant_id uuid,
        _unit_id uuid,
        _permission text
      )
      returns boolean language sql stable security definer
      set search_path = public, pg_temp
      as $body$
        select (select auth.uid()) is not null and (
          (_unit_id is not null and exists (
            select 1 from public.scoped_unit_ids(_tenant_id, (select auth.uid()), _permission) s
            where s.unit_id = _unit_id
          ))
          or (_unit_id is null and exists (
            select 1
            from public.security_user_roles sur
            join public.security_roles sr on sr.id = sur.role_id and sr.ativo
            join public.security_role_permissions srp on srp.role_id = sr.id
            join public.security_permissions sp on sp.id = srp.permission_id
            where sur.tenant_id = _tenant_id and sur.user_id = (select auth.uid())
              and sur.valid_from <= current_date
              and (sur.valid_to is null or sur.valid_to >= current_date)
              and sur.revoked_at is null
              and sp.codigo = _permission
              and not exists (
                select 1 from public.security_user_unit_scopes s where s.user_role_id = sur.id
              )
          ))
        )
      $body$
    $fn$;

    execute $fn$
      create or replace function private.can_access_person(_person_id uuid, _permission text)
      returns boolean language sql stable security definer
      set search_path = public, pg_temp
      as $body$
        select (select auth.uid()) is not null and exists (
          select 1 from public.employment_links el
          where el.person_id = _person_id
            and private.has_unit_permission(el.tenant_id, el.unit_id, _permission)
        )
      $body$
    $fn$;

    revoke all on function private.has_unit_permission(uuid, uuid, text) from public;
    revoke all on function private.can_access_person(uuid, text) from public;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      grant usage on schema private to authenticated;
      grant execute on function private.has_unit_permission(uuid, uuid, text) to authenticated;
      grant execute on function private.can_access_person(uuid, text) to authenticated;
    end if;
  end if;
end $$;

-- Atualiza o helper criado na Sprint 1 para respeitar revogação sem apagar histórico.
do $$
begin
  if to_regnamespace('auth') is not null then
    execute $fn$
      create or replace function private.has_tenant_permission(_tenant_id uuid, _permission text)
      returns boolean language sql stable security definer
      set search_path = public, pg_temp
      as $body$
        select (select auth.uid()) is not null and exists (
          select 1
          from public.security_user_roles sur
          join public.security_roles sr on sr.id = sur.role_id and sr.ativo
          join public.security_role_permissions srp on srp.role_id = sur.role_id
          join public.security_permissions sp on sp.id = srp.permission_id
          where sur.tenant_id = _tenant_id
            and sur.user_id = (select auth.uid())
            and sur.valid_from <= current_date
            and (sur.valid_to is null or sur.valid_to >= current_date)
            and sur.revoked_at is null
            and sp.codigo = _permission
        )
      $body$
    $fn$;
  end if;
end $$;

alter table public.persons enable row level security;
alter table public.employment_links enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    drop policy if exists persons_scoped_read on public.persons;
    create policy persons_scoped_read on public.persons for select to authenticated
      using (private.can_access_person(id, 'people.read'));

    drop policy if exists employment_links_scoped_read on public.employment_links;
    create policy employment_links_scoped_read on public.employment_links for select to authenticated
      using (private.has_unit_permission(tenant_id, unit_id, 'people.read'));
    drop policy if exists employment_links_scoped_insert on public.employment_links;
    create policy employment_links_scoped_insert on public.employment_links for insert to authenticated
      with check (private.has_unit_permission(tenant_id, unit_id, 'people.manage'));
    drop policy if exists employment_links_scoped_update on public.employment_links;
    create policy employment_links_scoped_update on public.employment_links for update to authenticated
      using (private.has_unit_permission(tenant_id, unit_id, 'people.manage'))
      with check (private.has_unit_permission(tenant_id, unit_id, 'people.manage'));
  end if;
end $$;

-- O servidor é responsável pela inclusão/alteração de persons, evitando que um
-- cadastro global seja criado sem vínculo autorizado. anon não recebe acesso.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.persons from authenticated;
    grant select (id, cpf, full_name, social_name, personal_email, phone, created_at, updated_at)
      on public.persons to authenticated;
    grant select, insert, update on public.employment_links to authenticated;
    grant execute on function public.scoped_unit_ids(uuid, uuid, text) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.persons, public.employment_links to service_role;
    grant execute on function public.scoped_unit_ids(uuid, uuid, text) to service_role;
  end if;
end $$;

drop trigger if exists trg_persons_updated on public.persons;
create trigger trg_persons_updated before update on public.persons
  for each row execute function public.set_updated_at();
drop trigger if exists trg_employment_links_updated on public.employment_links;
create trigger trg_employment_links_updated before update on public.employment_links
  for each row execute function public.set_updated_at();

commit;
