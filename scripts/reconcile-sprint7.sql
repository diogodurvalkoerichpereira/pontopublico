select count(*) as eventos_cruzados from public.employment_special_events e join public.employment_links l on l.id=e.employment_link_id where e.tenant_id<>l.tenant_id;
select count(*) as progressoes_sem_valor from public.employment_special_events where event_type='progressao' and new_base_salary is null;
select count(*) as readaptacoes_sem_fim from public.employment_special_events where event_type='readaptacao' and (end_date is null or target_job_title is null);
select count(*) as rescisoes_com_total_divergente from public.termination_calculations where total_earnings<>salary_balance+notice_amount+thirteenth_amount+vacation_amount+fgts_penalty+other_earnings or net_amount<>total_earnings-deductions;
