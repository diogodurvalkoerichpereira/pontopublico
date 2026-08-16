-- Reconciliação somente leitura da Sprint 3. Executar em homologação.

select
  (select count(*) from public.person_dependents) as dependentes,
  (select count(*) from public.pension_beneficiaries) as pensionistas,
  (select count(*) from public.employment_link_movements) as movimentacoes,
  (select count(*) from public.payroll_rubrics) as rubricas,
  (select count(*) from public.payroll_rubric_versions) as versoes,
  (select count(*) from public.payroll_rubric_incidences) as incidencias;

select count(*) as inconsistencias
from public.person_dependents
where valid_to is not null and valid_to < valid_from;

select count(*) as inconsistencias
from public.pension_beneficiaries
where valid_to is not null and valid_to < valid_from;

select count(*) as inconsistencias
from (
  select tenant_id, employment_link_id, sum(percentage) as total
  from public.pension_beneficiaries
  where calculation_type = 'percentual'
    and valid_from <= current_date
    and (valid_to is null or valid_to >= current_date)
  group by tenant_id, employment_link_id
  having sum(percentage) > 100
) invalid_pension_rates;

select count(*) as inconsistencias
from public.employment_link_movements movement
join public.employment_links link on link.id = movement.employment_link_id
where movement.tenant_id <> link.tenant_id;

select count(*) as inconsistencias
from public.employment_link_movements movement
left join public.unidades target on target.id = movement.to_unit_id
where movement.to_unit_id is not null
  and (target.id is null or target.tenant_id <> movement.tenant_id);

select count(*) as inconsistencias
from public.employment_link_movements
where (document_path is null) <> (document_sha256 is null)
   or (document_sha256 is not null and document_sha256 !~ '^[0-9a-fA-F]{64}$');

select count(*) as inconsistencias
from public.payroll_rubric_versions first_version
join public.payroll_rubric_versions second_version
  on second_version.rubric_id = first_version.rubric_id
 and second_version.id > first_version.id
 and second_version.status = 'publicada'
 and first_version.status = 'publicada'
 and daterange(first_version.valid_from,
       coalesce(first_version.valid_to + 1, 'infinity'::date), '[)')
     && daterange(second_version.valid_from,
       coalesce(second_version.valid_to + 1, 'infinity'::date), '[)');

with recursive edges as (
  select version.rubric_id as source_id, incidence.depends_on_rubric_id as target_id
  from public.payroll_rubric_incidences incidence
  join public.payroll_rubric_versions version on version.id = incidence.version_id
  where incidence.active and incidence.depends_on_rubric_id is not null
), paths as (
  select source_id, target_id, array[source_id, target_id] as visited, false as cycle
  from edges
  union all
  select path.source_id, edge.target_id, path.visited || edge.target_id,
    edge.target_id = any(path.visited)
  from paths path
  join edges edge on edge.source_id = path.target_id
  where not path.cycle
)
select count(*) as inconsistencias from paths where cycle;

