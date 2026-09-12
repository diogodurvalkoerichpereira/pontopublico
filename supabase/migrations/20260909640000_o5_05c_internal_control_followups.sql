-- O5-05c — Historico de acompanhamento do apontamento de controle interno.
--
-- Ate aqui `updateInternalControlFinding` (O5-05) SOBRESCREVIA a `providencia` a
-- cada acompanhamento — o registro anterior se perdia, sem trilha de como o
-- apontamento evoluiu (aberto -> em_implementacao -> implementado/nao). Para a
-- accountability do controle interno (CF art. 74) essa trilha importa. Esta
-- migration cria o razao append-only dos acompanhamentos: uma linha por
-- atualizacao, com o status daquele momento e a providencia registrada.
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.internal_control_followups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  finding_id uuid not null references public.internal_control_findings(id) on delete restrict,
  status text not null,
  providencia text not null,
  data_referencia date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint icf_status_check check (status in ('em_implementacao', 'implementado', 'nao_implementado')),
  constraint icf_providencia_not_blank check (btrim(providencia) <> '')
);

create index if not exists internal_control_followups_finding_idx
  on public.internal_control_followups (tenant_id, finding_id, created_at);

-- Coerencia de ente: o apontamento acompanhado e da mesma entidade.
create or replace function public.validate_internal_control_followup()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  finding_tenant uuid;
begin
  select tenant_id into finding_tenant from public.internal_control_findings where id = new.finding_id;
  if finding_tenant is null or finding_tenant <> new.tenant_id then
    raise exception 'Acompanhamento de apontamento de outra entidade';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_internal_control_followup on public.internal_control_followups;
create trigger trg_validate_internal_control_followup
  before insert on public.internal_control_followups
  for each row execute function public.validate_internal_control_followup();

alter table public.internal_control_followups enable row level security;

-- Politicas so no ambiente Supabase (auth.*). Leitura por analytics.read, registro
-- por analytics.manage; sem update/delete (o razao nao se altera).
do $$
begin
  if to_regnamespace('auth') is not null then
    create policy icf_read on public.internal_control_followups for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'analytics.read'));
    create policy icf_insert on public.internal_control_followups for insert to authenticated
      with check (private.has_tenant_permission(tenant_id, 'analytics.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert on public.internal_control_followups to authenticated;
  end if;
end
$$;

commit;
