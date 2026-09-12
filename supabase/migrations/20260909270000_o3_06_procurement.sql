-- O3-06 (Onda 3 — Contratações) — Processo licitatório (Lei 14.133). O certame que
-- antecede o contrato: modalidade, objeto, valor estimado e o ciclo
-- aberta→homologada (ou fracassada/deserta/revogada). Só uma licitação homologada
-- vira contrato (a ligação ao contrato vem em refino). Reusa contracts.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.procurement_processes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  numero text not null,
  ano integer not null,
  modalidade text not null,
  objeto text not null,
  valor_estimado numeric(16,2) not null,
  status text not null default 'aberta',
  abertura date not null,
  homologado_em date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint proc_ano_check check (ano between 2000 and 2200),
  constraint proc_modalidade_check check (modalidade in (
    'pregao', 'concorrencia', 'concurso', 'leilao', 'dialogo_competitivo',
    'dispensa', 'inexigibilidade', 'credenciamento'
  )),
  constraint proc_status_check check (status in ('aberta', 'homologada', 'fracassada', 'deserta', 'revogada')),
  constraint proc_valor_pos check (valor_estimado > 0),
  constraint proc_objeto_not_blank check (btrim(objeto) <> ''),
  unique (tenant_id, ano, numero)
);

create index if not exists procurement_processes_ano_idx
  on public.procurement_processes (tenant_id, ano);

alter table public.procurement_processes enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy procurement_read on public.procurement_processes for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.read'));
    create policy procurement_manage on public.procurement_processes for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.manage'))
      with check (private.has_tenant_permission(tenant_id, 'contracts.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.procurement_processes to authenticated;
  end if;
end
$$;

commit;
