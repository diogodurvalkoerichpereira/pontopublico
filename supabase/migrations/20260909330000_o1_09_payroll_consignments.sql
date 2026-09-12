-- O1-09 (Onda 1 — Folha) — Consignações em folha e margem consignável (Lei
-- 10.820/2003 e regime do servidor). Descontos consignados (empréstimo, sindicato,
-- plano de saúde) têm de caber na MARGEM CONSIGNÁVEL — teto legal (padrão 35% da
-- remuneração) sobre a soma das parcelas ativas. A margem é conferida na inclusão:
-- uma consignação nova só entra se couber. Reusa people.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.payroll_consignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  tipo text not null,
  consignatario text not null,
  valor_parcela numeric(16,2) not null,
  parcelas_total integer not null,
  parcelas_pagas integer not null default 0,
  status text not null default 'ativa',
  inicio date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint consignment_tipo_check check (tipo in ('emprestimo', 'sindicato', 'plano_saude', 'pensao', 'outro')),
  constraint consignment_status_check check (status in ('ativa', 'quitada', 'cancelada')),
  constraint consignment_parcela_pos check (valor_parcela > 0),
  constraint consignment_parcelas_pos check (parcelas_total >= 1),
  constraint consignment_pagas_range check (parcelas_pagas between 0 and parcelas_total),
  constraint consignment_consignatario_not_blank check (btrim(consignatario) <> '')
);

create index if not exists payroll_consignments_link_idx
  on public.payroll_consignments (tenant_id, employment_link_id, status);

-- Coerência de ente: o vínculo consignado é da mesma entidade da consignação.
create or replace function public.validate_payroll_consignment() returns trigger language plpgsql set search_path=public as $$
declare lt uuid;
begin
  select tenant_id into lt from public.employment_links where id=new.employment_link_id;
  if lt is null or lt<>new.tenant_id then
    raise exception 'Consignacao de vinculo de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_payroll_consignment before insert or update on public.payroll_consignments
  for each row execute function public.validate_payroll_consignment();

alter table public.payroll_consignments enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy consignment_read on public.payroll_consignments for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.read'));
    create policy consignment_manage on public.payroll_consignments for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.manage'))
      with check (private.has_tenant_permission(tenant_id, 'people.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.payroll_consignments to authenticated;
  end if;
end
$$;

commit;
