-- O1-02c — Atribuicao de rubricas por regime previdenciario.
--
-- O O1-02b modelou o regime (pension_regimes) e ligou o vinculo. Aqui as rubricas
-- de contribuicao (servidor/patronal/inativo) sao declaradas UMA VEZ por regime,
-- em pension_regime_rubrics, e o ciclo aplica-as automaticamente a todo vinculo
-- daquele regime — sem atribuicao manual por servidor. A atribuicao explicita por
-- vinculo (employment_link_rubrics) continua valendo e tem precedencia (o ciclo
-- deduplica preferindo-a). Nao altera o motor puro (ADR 0003): so a camada de
-- selecao de rubricas do ciclo.
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.pension_regime_rubrics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  pension_regime_id uuid not null references public.pension_regimes(id) on delete restrict,
  rubric_id uuid not null references public.payroll_rubrics(id) on delete restrict,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint pension_regime_rubrics_uq unique (tenant_id, pension_regime_id, rubric_id)
);

create index if not exists pension_regime_rubrics_regime_idx
  on public.pension_regime_rubrics (pension_regime_id);

-- Coerencia: o regime e a rubrica do mapeamento devem ser da mesma entidade.
create or replace function public.validate_pension_regime_rubric()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  regime_tenant uuid;
  rubric_tenant uuid;
begin
  select tenant_id into regime_tenant from public.pension_regimes where id = new.pension_regime_id;
  if regime_tenant is null or regime_tenant <> new.tenant_id then
    raise exception 'O regime deve pertencer a mesma entidade do mapeamento';
  end if;
  select tenant_id into rubric_tenant from public.payroll_rubrics where id = new.rubric_id;
  if rubric_tenant is null or rubric_tenant <> new.tenant_id then
    raise exception 'A rubrica deve pertencer a mesma entidade do mapeamento';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_pension_regime_rubric on public.pension_regime_rubrics;
create trigger trg_validate_pension_regime_rubric
  before insert or update of tenant_id, pension_regime_id, rubric_id
  on public.pension_regime_rubrics
  for each row execute function public.validate_pension_regime_rubric();

alter table public.pension_regime_rubrics enable row level security;

-- Politicas so no ambiente Supabase (auth.*). Leitura por quem roda a folha
-- (payroll.simulate); gestao por quem administra atribuicoes.
do $$
begin
  if to_regnamespace('auth') is not null then
    create policy pension_regime_rubrics_read on public.pension_regime_rubrics for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.simulate'));
    create policy pension_regime_rubrics_manage on public.pension_regime_rubrics for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.assignments.manage'))
      with check (private.has_tenant_permission(tenant_id, 'payroll.assignments.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, delete on public.pension_regime_rubrics to authenticated;
  end if;
end
$$;

commit;
