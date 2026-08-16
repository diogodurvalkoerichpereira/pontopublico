-- Executar após a migração da Sprint 4 em homologação.
-- O resultado esperado é zero em todas as colunas de inconsistência.

select
  count(*) filter (where failed_login_attempts < 0) as usuarios_tentativas_invalidas,
  count(*) filter (where locked_until is not null and locked_until < now() - interval '30 days')
    as bloqueios_antigos
from public.app_users;

select
  count(*) filter (where expires_at <= issued_at) as sessoes_vigencia_invalida,
  count(*) filter (where revoked_at is null and expires_at <= now()) as sessoes_expiradas_pendentes
from private.auth_sessions;

select count(*) as versoes_publicadas_sem_formula
from public.payroll_rubric_versions
where status='publicada'
  and (formula_ast is null or formula_checksum is null or formula_checksum !~ '^[0-9a-f]{64}$');

select count(*) as atribuicoes_com_referencia_cruzada
from public.employment_link_rubrics assignment
join public.employment_links link on link.id=assignment.employment_link_id
join public.payroll_rubrics rubric on rubric.id=assignment.rubric_id
where assignment.tenant_id<>link.tenant_id or assignment.tenant_id<>rubric.tenant_id;

select count(*) as atribuicoes_ativas_sobrepostas
from public.employment_link_rubrics a
join public.employment_link_rubrics b
  on b.id>a.id and b.employment_link_id=a.employment_link_id
 and b.rubric_id=a.rubric_id and a.status='ativo' and b.status='ativo'
 and daterange(a.valid_from,coalesce(a.valid_to+1,'infinity'::date),'[)')
     && daterange(b.valid_from,coalesce(b.valid_to+1,'infinity'::date),'[)');

select count(*) as itens_com_referencia_cruzada
from public.payroll_calculation_items item
join public.payroll_calculation_runs run on run.id=item.run_id
join public.employment_links link on link.id=item.employment_link_id
join public.payroll_rubrics rubric on rubric.id=item.rubric_id
join public.payroll_rubric_versions version on version.id=item.version_id
where item.tenant_id<>run.tenant_id or item.tenant_id<>link.tenant_id
   or item.tenant_id<>rubric.tenant_id or item.rubric_id<>version.rubric_id;

select count(*) as simulacoes_concluidas_sem_memoria
from public.payroll_calculation_runs run
where run.status='concluida' and not exists (
  select 1 from public.payroll_calculation_items item where item.run_id=run.id
);
