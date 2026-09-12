-- O2-09 (Onda 2 — núcleo SIAFIC) — Restos a pagar (Lei 4.320, art. 36). No
-- encerramento do exercício, os empenhos não pagos são inscritos em restos a pagar:
-- PROCESSADOS (já liquidados, só falta pagar) e NÃO PROCESSADOS (empenhados, ainda
-- não liquidados). Empenho pago ou anulado não inscreve. Cada empenho inscreve uma
-- só vez (idempotente). Pagar o resto quita o empenho de origem. Reusa budget.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.restos_a_pagar (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  commitment_id uuid not null references public.budget_commitments(id) on delete restrict,
  exercicio_origem integer not null,
  tipo text not null,
  valor numeric(16,2) not null,
  inscrito_em date not null,
  status text not null default 'inscrito',
  pago_em date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint restos_exercicio_check check (exercicio_origem between 2000 and 2200),
  constraint restos_tipo_check check (tipo in ('processado', 'nao_processado')),
  constraint restos_valor_pos check (valor > 0),
  constraint restos_status_check check (status in ('inscrito', 'pago', 'cancelado')),
  unique (tenant_id, commitment_id)
);

create index if not exists restos_a_pagar_exercicio_idx
  on public.restos_a_pagar (tenant_id, exercicio_origem);

-- Coerência de ente: o empenho inscrito é da mesma entidade do resto.
create or replace function public.validate_resto_a_pagar() returns trigger language plpgsql set search_path=public as $$
declare ct uuid;
begin
  select tenant_id into ct from public.budget_commitments where id=new.commitment_id;
  if ct is null or ct<>new.tenant_id then
    raise exception 'Resto a pagar de empenho de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_resto_a_pagar before insert or update on public.restos_a_pagar
  for each row execute function public.validate_resto_a_pagar();

alter table public.restos_a_pagar enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy restos_read on public.restos_a_pagar for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.read'));
    create policy restos_manage on public.restos_a_pagar for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.manage'))
      with check (private.has_tenant_permission(tenant_id, 'budget.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.restos_a_pagar to authenticated;
  end if;
end
$$;

commit;
