-- O2-02 (Onda 2 — núcleo SIAFIC) — Empenho contra dotação. O empenho é o primeiro
-- estágio da despesa (Lei 4.320, art. 58): reserva parte do saldo da dotação para
-- uma obrigação. Aqui cada empenho referencia uma dotação (`budget_appropriations`)
-- e RESERVA seu valor no `valor_empenhado` da dotação — atômico, nunca acima do
-- saldo. A liquidação e o pagamento (estágios seguintes) vêm no O2-03, reusando o
-- motor de estados. Ver ROADMAP_GESTAO_PUBLICA.md e ADR 0001.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

-- Contador de numeração de empenho por ente e exercício (serializa a numeração;
-- molde de time_clock_counters). A linha travada FOR UPDATE gera o próximo número.
create table if not exists public.budget_commitment_counters (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  last_numero bigint not null default 0,
  primary key (tenant_id, exercicio)
);

create table if not exists public.budget_commitments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  appropriation_id uuid not null references public.budget_appropriations(id) on delete restrict,
  exercicio integer not null,
  numero bigint not null,
  data_empenho date not null,
  tipo text not null default 'ordinario',
  credor text not null,
  historico text not null,
  valor numeric(16,2) not null,
  status text not null default 'empenhado',
  source text not null default 'manual',
  source_ref uuid,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint budget_commitment_tipo_check check (tipo in ('ordinario', 'global', 'estimativo')),
  constraint budget_commitment_status_check check (status in ('empenhado', 'liquidado', 'pago', 'anulado')),
  constraint budget_commitment_source_check check (source in ('manual', 'folha')),
  constraint budget_commitment_valor_pos check (valor > 0),
  constraint budget_commitment_credor_not_blank check (btrim(credor) <> ''),
  unique (tenant_id, exercicio, numero)
);

create index if not exists budget_commitments_appropriation_idx
  on public.budget_commitments (appropriation_id);

-- Coerência de ente: a dotação empenhada é da mesma entidade do empenho.
create or replace function public.validate_budget_commitment() returns trigger language plpgsql set search_path=public as $$
declare at uuid;
begin
  select tenant_id into at from public.budget_appropriations where id=new.appropriation_id;
  if at is null or at<>new.tenant_id then
    raise exception 'Empenho contem dotacao de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_budget_commitment before insert or update on public.budget_commitments
  for each row execute function public.validate_budget_commitment();

alter table public.budget_commitments enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy budget_commitment_read on public.budget_commitments for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.read'));
    create policy budget_commitment_manage on public.budget_commitments for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.manage'))
      with check (private.has_tenant_permission(tenant_id, 'budget.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.budget_commitments to authenticated;
  end if;
end
$$;

commit;
