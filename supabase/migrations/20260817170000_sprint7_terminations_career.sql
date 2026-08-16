-- Sprint 7 / EP07: rescisões e eventos funcionais especiais.
begin;

insert into public.security_permissions (codigo,modulo,nome,criticidade) values
 ('employment.special.read','pessoas','Consultar eventos funcionais especiais','sensivel'),
 ('employment.special.manage','pessoas','Gerenciar eventos funcionais especiais','critica'),
 ('termination.read','folha','Consultar cálculos rescisórios','sensivel'),
 ('termination.manage','folha','Calcular e efetivar rescisões','critica')
on conflict(codigo) do update set modulo=excluded.modulo,nome=excluded.nome,criticidade=excluded.criticidade;

insert into public.security_role_permissions(role_id,permission_id)
select r.id,p.id from public.security_roles r join public.security_permissions p
 on p.codigo in ('employment.special.read','employment.special.manage','termination.read','termination.manage')
where r.codigo='tenant_admin' on conflict do nothing;
insert into public.security_role_permissions(role_id,permission_id)
select r.id,p.id from public.security_roles r join public.security_permissions p
 on p.codigo in ('employment.special.read','termination.read')
where r.codigo in ('sector_manager','auditor') on conflict do nothing;

alter table public.employment_link_movements drop constraint if exists employment_movements_type_check;
alter table public.employment_link_movements add constraint employment_movements_type_check check (
 movement_type in ('admissao','lotacao','afastamento','cessao','retorno','desligamento',
 'reativacao_agendada','readaptacao','progressao','reintegracao')
);

create table public.career_levels (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),
 career_code text not null,class_code text not null,level_code text not null,
 reference_code text not null,base_salary numeric(14,2) not null,effective_from date not null,
 effective_to date,created_at timestamptz not null default now(),
 check(base_salary>=0),check(effective_to is null or effective_to>=effective_from),
 unique(tenant_id,career_code,class_code,level_code,reference_code,effective_from)
);

create table public.employment_special_events (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),
 employment_link_id uuid not null references public.employment_links(id),event_type text not null,
 effective_date date not null,end_date date,status text not null default 'agendado',
 target_job_title text,target_unit_id uuid references public.unidades(id),
 career_level_id uuid references public.career_levels(id),new_base_salary numeric(14,2),
 legal_basis text not null,notes text,applied_at timestamptz,created_by uuid references public.profiles(id),
 created_at timestamptz not null default now(),
 check(event_type in ('reativacao','readaptacao','progressao','reintegracao')),
 check(status in ('agendado','aplicado','cancelado','encerrado')),
 check(end_date is null or end_date>=effective_date),check(new_base_salary is null or new_base_salary>=0),
 check(length(btrim(legal_basis))>0)
);
create index employment_special_events_due_idx on public.employment_special_events
 (tenant_id,status,effective_date) where status='agendado';

create table public.termination_calculations (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id),
 employment_link_id uuid not null references public.employment_links(id),termination_date date not null,
 reason text not null,notice_type text not null,worked_days integer not null,
 thirteenth_months integer not null,vacation_months integer not null,fgts_balance numeric(14,2) not null default 0,
 fgts_penalty_rate numeric(7,4) not null default 0,other_earnings numeric(14,2) not null default 0,
 deductions numeric(14,2) not null default 0,salary_balance numeric(14,2) not null,
 notice_amount numeric(14,2) not null,thirteenth_amount numeric(14,2) not null,
 vacation_amount numeric(14,2) not null,fgts_penalty numeric(14,2) not null,
 total_earnings numeric(14,2) not null,net_amount numeric(14,2) not null,
 memory jsonb not null,result_checksum text not null,status text not null default 'rascunho',
 approved_by uuid references public.profiles(id),approved_at timestamptz,applied_by uuid references public.profiles(id),
 applied_at timestamptz,created_by uuid references public.profiles(id),created_at timestamptz not null default now(),
 check(reason in ('sem_justa_causa','pedido_demissao','justa_causa','termino_contrato','aposentadoria')),
 check(notice_type in ('trabalhado','indenizado','dispensado')),
 check(worked_days between 0 and 30),check(thirteenth_months between 0 and 12),
 check(vacation_months between 0 and 12),check(fgts_penalty_rate between 0 and 1),
 check(jsonb_typeof(memory)='object'),check(result_checksum~'^[0-9a-f]{64}$'),
 check(status in ('rascunho','aprovada','efetivada','cancelada')),
 unique(tenant_id,employment_link_id,termination_date)
);

create or replace function public.validate_employment_special_reference() returns trigger language plpgsql set search_path=public as $$
declare lt uuid; declare ct uuid; declare ut uuid;
begin
 select tenant_id into lt from public.employment_links where id=new.employment_link_id;
 if new.career_level_id is not null then select tenant_id into ct from public.career_levels where id=new.career_level_id; end if;
 if new.target_unit_id is not null then select tenant_id into ut from public.unidades where id=new.target_unit_id; end if;
 if lt is null or lt<>new.tenant_id or (new.career_level_id is not null and ct<>new.tenant_id)
   or (new.target_unit_id is not null and ut<>new.tenant_id) then raise exception 'Evento funcional contém referência de outra entidade'; end if;
 return new;
end $$;
create trigger trg_validate_employment_special before insert or update on public.employment_special_events
 for each row execute function public.validate_employment_special_reference();

create or replace function public.validate_termination_reference() returns trigger language plpgsql set search_path=public as $$
declare lt uuid;
begin select tenant_id into lt from public.employment_links where id=new.employment_link_id;
 if lt is null or lt<>new.tenant_id then raise exception 'Rescisão contém vínculo de outra entidade'; end if; return new; end $$;
create trigger trg_validate_termination before insert or update on public.termination_calculations
 for each row execute function public.validate_termination_reference();

alter table public.career_levels enable row level security;
alter table public.employment_special_events enable row level security;
alter table public.termination_calculations enable row level security;
do $$ begin if to_regnamespace('auth') is not null then
 create policy career_read on public.career_levels for select to authenticated using(private.has_tenant_permission(tenant_id,'employment.special.read'));
 create policy career_manage on public.career_levels for all to authenticated using(private.has_tenant_permission(tenant_id,'employment.special.manage')) with check(private.has_tenant_permission(tenant_id,'employment.special.manage'));
 create policy special_events_read on public.employment_special_events for select to authenticated using(private.has_tenant_permission(tenant_id,'employment.special.read'));
 create policy special_events_manage on public.employment_special_events for all to authenticated using(private.has_tenant_permission(tenant_id,'employment.special.manage')) with check(private.has_tenant_permission(tenant_id,'employment.special.manage'));
 create policy termination_read on public.termination_calculations for select to authenticated using(private.has_tenant_permission(tenant_id,'termination.read'));
 create policy termination_manage on public.termination_calculations for all to authenticated using(private.has_tenant_permission(tenant_id,'termination.manage')) with check(private.has_tenant_permission(tenant_id,'termination.manage'));
end if; end $$;
revoke all on public.career_levels,public.employment_special_events,public.termination_calculations from anon;
do $$ begin if exists(select 1 from pg_roles where rolname='authenticated') then
 grant select,insert,update on public.career_levels,public.employment_special_events,public.termination_calculations to authenticated;
end if; if exists(select 1 from pg_roles where rolname='service_role') then
 grant all on public.career_levels,public.employment_special_events,public.termination_calculations to service_role;
end if; end $$;
commit;
