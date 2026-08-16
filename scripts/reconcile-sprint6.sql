-- Executar após a migração da Sprint 6 em homologação.
-- O resultado esperado é zero em todas as colunas de inconsistência.

select count(*) as complementares_com_origem_invalida
from public.payroll_cycles special
left join public.payroll_cycles source on source.id=special.source_cycle_id
where special.cycle_type='complementar'
  and (source.id is null or source.tenant_id<>special.tenant_id
    or source.reference_month<>special.reference_month
    or source.cycle_type<>'mensal' or source.status<>'fechada');

select count(*) as ajustes_com_referencia_cruzada
from public.payroll_special_adjustments adjustment
join public.payroll_cycles cycle on cycle.id=adjustment.cycle_id
join public.employment_links link on link.id=adjustment.employment_link_id
where adjustment.tenant_id<>cycle.tenant_id
   or adjustment.tenant_id<>link.tenant_id
   or cycle.cycle_type<>'complementar';

select count(*) as segundas_parcelas_sem_primeira_fechada
from public.payroll_cycles second_cycle
where second_cycle.cycle_type='decimo_segunda' and not exists (
  select 1 from public.payroll_cycles first_cycle
  where first_cycle.tenant_id=second_cycle.tenant_id
    and first_cycle.cycle_type='decimo_primeira'
    and first_cycle.status='fechada'
    and extract(year from first_cycle.reference_month)=extract(year from second_cycle.reference_month)
);

select count(*) as compensacoes_invalidas
from public.payroll_advance_compensations compensation
join public.payroll_cycles advance on advance.id=compensation.advance_cycle_id
join public.payroll_cycles monthly on monthly.id=compensation.monthly_cycle_id
join public.employment_links link on link.id=compensation.employment_link_id
where compensation.tenant_id<>advance.tenant_id
   or compensation.tenant_id<>monthly.tenant_id
   or compensation.tenant_id<>link.tenant_id
   or advance.cycle_type<>'adiantamento' or advance.status<>'fechada'
   or monthly.cycle_type<>'mensal'
   or advance.reference_month<>monthly.reference_month;

select count(*) as adiantamentos_fechados_sem_compensacao_em_folha_mensal_fechada
from public.payroll_cycles advance
join public.payroll_cycle_results result on result.cycle_id=advance.id
where advance.cycle_type='adiantamento' and advance.status='fechada'
  and exists (
    select 1 from public.payroll_cycles monthly
    where monthly.tenant_id=advance.tenant_id
      and monthly.reference_month=advance.reference_month
      and monthly.cycle_type='mensal' and monthly.status='fechada'
  )
  and not exists (
    select 1 from public.payroll_advance_compensations compensation
    where compensation.advance_cycle_id=advance.id
      and compensation.employment_link_id=result.employment_link_id
  );
