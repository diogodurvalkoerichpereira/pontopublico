-- O1-08 — Interface de empenho da folha (PCASP).
--
-- Uma folha mensal FECHADA emite uma requisicao de empenho: a despesa bruta de
-- pessoal (proventos do ciclo) classificada por natureza de despesa (PCASP). E a
-- INTERFACE para a contabilidade da Onda 2 consumir — o modelo de dados nasce
-- certo antes do nucleo SIAFIC. NAO e um empenho homologado no SIAFIC (a emissao,
-- reserva orcamentaria e escrituracao contabil vem na Onda 2); por isso o artefato
-- se chama "requisicao de empenho", nao "empenho" (regra do CLAUDE.md).
--
-- Retencoes (INSS/IRRF/consignacoes) sao extra-orcamentarias: sao descontadas do
-- bruto e recolhidas a terceiros, NAO integram o empenho da despesa. Obrigacoes
-- patronais (natureza 3.1.90.13) sao despesa adicional e entram quando o calculo
-- patronal existir (incremento futuro). v1: base = proventos do ciclo.
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.payroll_empenho_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  cycle_id uuid not null references public.payroll_cycles(id) on delete restrict,
  reference_month date not null,
  fonte_recurso text not null,
  base_earnings numeric(16,2) not null,
  total_amount numeric(16,2) not null,
  status text not null default 'rascunho',
  memory jsonb not null,
  result_checksum text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint payroll_empenho_fonte_not_blank check (btrim(fonte_recurso) <> ''),
  constraint payroll_empenho_status_check check (status in ('rascunho', 'emitida', 'cancelada')),
  constraint payroll_empenho_total_nonneg check (total_amount >= 0),
  constraint payroll_empenho_checksum_hex check (result_checksum ~ '^[0-9a-f]{64}$')
);

-- Uma requisicao por folha (competencia/ciclo).
create unique index if not exists payroll_empenho_cycle_uq
  on public.payroll_empenho_requests (cycle_id);

create table if not exists public.payroll_empenho_request_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  request_id uuid not null references public.payroll_empenho_requests(id) on delete cascade,
  natureza_despesa text not null,
  description text not null,
  amount numeric(16,2) not null,
  created_at timestamptz not null default now(),
  constraint payroll_empenho_line_natureza_check check (natureza_despesa ~ '^[0-9.]{4,20}$'),
  constraint payroll_empenho_line_desc_not_blank check (btrim(description) <> ''),
  constraint payroll_empenho_line_amount_pos check (amount > 0)
);

create index if not exists payroll_empenho_lines_request_idx
  on public.payroll_empenho_request_lines (request_id);

-- Coerencia de ente: a folha e as linhas sao da mesma entidade da requisicao.
create or replace function public.validate_payroll_empenho_request() returns trigger language plpgsql set search_path=public as $$
declare ct uuid;
begin
  select tenant_id into ct from public.payroll_cycles where id=new.cycle_id;
  if ct is null or ct<>new.tenant_id then
    raise exception 'Requisicao de empenho contem folha de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_payroll_empenho_request before insert or update on public.payroll_empenho_requests
  for each row execute function public.validate_payroll_empenho_request();

create or replace function public.validate_payroll_empenho_line() returns trigger language plpgsql set search_path=public as $$
declare rt uuid;
begin
  select tenant_id into rt from public.payroll_empenho_requests where id=new.request_id;
  if rt is null or rt<>new.tenant_id then
    raise exception 'Linha de empenho contem requisicao de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_payroll_empenho_line before insert or update on public.payroll_empenho_request_lines
  for each row execute function public.validate_payroll_empenho_line();

alter table public.payroll_empenho_requests enable row level security;
alter table public.payroll_empenho_request_lines enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy payroll_empenho_read on public.payroll_empenho_requests for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.cycles.read'));
    create policy payroll_empenho_manage on public.payroll_empenho_requests for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.cycles.close'))
      with check (private.has_tenant_permission(tenant_id, 'payroll.cycles.close'));
    create policy payroll_empenho_line_read on public.payroll_empenho_request_lines for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.cycles.read'));
    create policy payroll_empenho_line_manage on public.payroll_empenho_request_lines for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'payroll.cycles.close'))
      with check (private.has_tenant_permission(tenant_id, 'payroll.cycles.close'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on public.payroll_empenho_requests to authenticated;
    grant select, insert, update, delete on public.payroll_empenho_request_lines to authenticated;
  end if;
end
$$;

commit;
