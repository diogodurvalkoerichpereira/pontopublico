-- Executar após a migração da Sprint 2 em homologação.
-- Todas as consultas são somente leitura e devem retornar zero em "inconsistencias".

select
  (select count(*) from public.profiles) as perfis_legados,
  (select count(*) from public.profiles where person_id is not null) as perfis_com_pessoa,
  (select count(*) from public.persons) as pessoas_unicas,
  (select count(*) from public.tenant_memberships where status = 'ativo') as memberships_ativos,
  (select count(*) from public.employment_links where source_profile_id is not null) as vinculos_migrados;

select count(*) as inconsistencias
from public.profiles
where person_id is null;

select count(*) as inconsistencias
from public.unidades
where tenant_id is null or codigo is null or btrim(codigo) = '';

select count(*) as inconsistencias
from public.employment_links el
join public.unidades u on u.id = el.unit_id
where el.tenant_id <> u.tenant_id;

select count(*) as inconsistencias
from (
  select regexp_replace(cpf, '\D', '', 'g')
  from public.persons
  where length(regexp_replace(coalesce(cpf, ''), '\D', '', 'g')) = 11
  group by regexp_replace(cpf, '\D', '', 'g')
  having count(*) > 1
) duplicated_cpf;

select count(*) as inconsistencias
from (
  select tenant_id, lower(registration_number)
  from public.employment_links
  group by tenant_id, lower(registration_number)
  having count(*) > 1
) duplicated_registration;

select tenant_id, status, count(*)
from public.employment_links
group by tenant_id, status
order by tenant_id, status;

