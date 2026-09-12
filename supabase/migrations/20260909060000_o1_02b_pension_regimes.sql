-- O1-02b — Regime previdenciario como entidade de primeira classe.
--
-- Ate aqui o regime de um servidor era texto livre (employment_links.work_regime
-- / employment_type), sem integridade: nao dava para distinguir com seguranca
-- estatutario (RPPS) de celetista (RGPS/INSS). Esta migration cria pension_regimes
-- por ente e liga employment_links.pension_regime_id com coerencia de tenant no
-- trigger. E a fundacao do RPPS por regime (a atribuicao automatica de rubricas
-- por regime fica no O1-02c). Reusa as permissoes people.read/people.manage.
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.pension_regimes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  code text not null,
  name text not null,
  regime_type text not null,
  status text not null default 'ativo',
  description text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pension_regimes_code_not_blank check (btrim(code) <> ''),
  constraint pension_regimes_code_format check (code ~ '^[A-Z0-9_]+$'),
  constraint pension_regimes_type_check check (regime_type in ('rpps', 'rgps')),
  constraint pension_regimes_status_check check (status in ('ativo', 'inativo'))
);

create unique index if not exists pension_regimes_tenant_code_uq
  on public.pension_regimes (tenant_id, lower(code));

alter table public.employment_links
  add column if not exists pension_regime_id uuid references public.pension_regimes(id) on delete restrict;

create index if not exists employment_links_pension_regime_idx
  on public.employment_links (pension_regime_id);

-- Re-declara a validacao do vinculo acrescentando a coerencia de tenant do regime
-- (mesmo molde do unit_id). O arquivo original (sprint2) e imutavel.
create or replace function public.validate_employment_link()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  unit_tenant uuid;
  regime_tenant uuid;
begin
  if new.unit_id is not null then
    select tenant_id into unit_tenant from public.unidades where id = new.unit_id;
    if unit_tenant is null or unit_tenant <> new.tenant_id then
      raise exception 'A lotacao deve pertencer a mesma entidade do vinculo';
    end if;
  end if;

  if new.pension_regime_id is not null then
    select tenant_id into regime_tenant from public.pension_regimes where id = new.pension_regime_id;
    if regime_tenant is null or regime_tenant <> new.tenant_id then
      raise exception 'O regime previdenciario deve pertencer a mesma entidade do vinculo';
    end if;
  end if;

  if new.status = 'ativo' and (
    new.unit_id is null or nullif(btrim(new.employment_type), '') is null
    or nullif(btrim(new.work_regime), '') is null
    or nullif(btrim(new.job_title), '') is null
    or new.weekly_hours is null or new.admission_date is null
  ) then
    raise exception 'Vinculo ativo exige lotacao, tipo, regime, cargo, jornada e admissao';
  end if;
  return new;
end;
$$;

-- Re-cria o trigger com pension_regime_id na lista `update of`, senao um UPDATE que
-- so troca o regime nao revalida a coerencia.
drop trigger if exists trg_validate_employment_link on public.employment_links;
create trigger trg_validate_employment_link
  before insert or update of tenant_id, unit_id, status, employment_type,
    work_regime, job_title, weekly_hours, admission_date, pension_regime_id
  on public.employment_links
  for each row execute function public.validate_employment_link();

alter table public.pension_regimes enable row level security;

-- Politicas so no ambiente Supabase (auth.*); no backend proprio a autorizacao e
-- 100% aplicacional. Catalogo por ente: leitura por people.read, gestao por
-- people.manage (tenant-scoped, sem unidade).
do $$
begin
  if to_regnamespace('auth') is not null then
    create policy pension_regimes_read on public.pension_regimes for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.read'));
    create policy pension_regimes_manage on public.pension_regimes for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.manage'))
      with check (private.has_tenant_permission(tenant_id, 'people.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.pension_regimes to authenticated;
  end if;
end
$$;

commit;
