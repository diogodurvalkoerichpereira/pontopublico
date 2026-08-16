-- Executar após a migração da Sprint 5 em homologação.
-- O resultado esperado é zero em todas as colunas de inconsistência.

select count(*) as ciclos_com_origem_cruzada
from public.payroll_cycles cycle
join public.payroll_calculation_runs run on run.id=cycle.source_run_id
where cycle.tenant_id<>run.tenant_id or cycle.reference_month<>run.reference_month;

select count(*) as resultados_com_referencia_cruzada
from public.payroll_cycle_results result
join public.payroll_cycles cycle on cycle.id=result.cycle_id
join public.employment_links link on link.id=result.employment_link_id
where result.tenant_id<>cycle.tenant_id or result.tenant_id<>link.tenant_id;

select count(*) as resultados_com_totais_invalidos
from public.payroll_cycle_results
where net_amount<>earnings-deductions or result_checksum !~ '^[0-9a-f]{64}$';

select count(*) as ciclos_com_totais_divergentes
from public.payroll_cycles cycle
left join lateral (
  select count(*) links,
    coalesce(sum(items_count),0) items,
    coalesce(sum(earnings),0) earnings,
    coalesce(sum(deductions),0) deductions,
    coalesce(sum(net_amount),0) net
  from public.payroll_cycle_results where cycle_id=cycle.id
) result on true
where cycle.links_count<>result.links
   or cycle.items_count<>result.items
   or cycle.total_earnings<>result.earnings
   or cycle.total_deductions<>result.deductions
   or cycle.total_net<>result.net;

select count(*) as ciclos_fechados_sem_trilha
from public.payroll_cycles cycle
where cycle.status='fechada' and not exists (
  select 1 from public.payroll_cycle_events event
  where event.cycle_id=cycle.id and event.to_status='fechada'
);
