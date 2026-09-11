-- O4-09 (Onda 4 — Tributação) — Execução fiscal (Lei 6.830). Registra o ajuizamento da
-- cobrança de uma CDA: número do processo (informado — vem do Judiciário), data de
-- ajuizamento, valor ajuizado (fixado da CDA) e o andamento (ajuizada → suspensa →
-- extinta/quitada). É o REGISTRO interno do processo — não peticiona nem integra ao
-- Judiciário (isso depende de integração externa). Reusa taxes.*. Uma execução por CDA.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.fiscal_executions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  cda_id uuid not null references public.active_debt_certificates(id) on delete restrict,
  numero_processo text not null,
  data_ajuizamento date not null,
  valor_ajuizado numeric(16,2) not null,
  status text not null default 'ajuizada',
  observacao text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_exec_status_check check (status in ('ajuizada', 'suspensa', 'extinta', 'quitada')),
  constraint fiscal_exec_valor_pos check (valor_ajuizado > 0),
  constraint fiscal_exec_processo_not_blank check (btrim(numero_processo) <> ''),
  unique (tenant_id, cda_id),
  unique (tenant_id, numero_processo)
);

create index if not exists fiscal_executions_status_idx
  on public.fiscal_executions (tenant_id, status);

-- Coerência de ente: a CDA executada é da mesma entidade.
create or replace function public.validate_fiscal_execution() returns trigger language plpgsql set search_path=public as $$
declare ct uuid;
begin
  select tenant_id into ct from public.active_debt_certificates where id=new.cda_id;
  if ct is null or ct<>new.tenant_id then
    raise exception 'Execucao fiscal de CDA de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_fiscal_execution before insert or update on public.fiscal_executions
  for each row execute function public.validate_fiscal_execution();

alter table public.fiscal_executions enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy fiscal_exec_read on public.fiscal_executions for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.read'));
    create policy fiscal_exec_manage on public.fiscal_executions for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.manage'))
      with check (private.has_tenant_permission(tenant_id, 'taxes.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.fiscal_executions to authenticated;
  end if;
end
$$;

commit;
