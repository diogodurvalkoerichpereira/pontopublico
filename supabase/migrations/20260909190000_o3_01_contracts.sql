-- O3-01 (Onda 3 — Materiais e Contratações) — Contratos administrativos (Lei
-- 14.133/2021). Registro do contrato com fornecedor, objeto, modalidade de
-- contratação, valor e vigência. O valor_empenhado é o quanto do contrato já virou
-- empenho (ligação com a Onda 2 vem em incremento seguinte). É a base para
-- almoxarifado, patrimônio e a remessa ao PNCP.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

insert into public.security_permissions (codigo, modulo, nome, criticidade)
values
  ('contracts.read', 'contratacoes', 'Consultar contratos', 'sensivel'),
  ('contracts.manage', 'contratacoes', 'Gerir contratos', 'critica')
on conflict (codigo) do update set nome = excluded.nome;

insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on p.codigo in ('contracts.read', 'contracts.manage')
where r.codigo = 'tenant_admin'
on conflict do nothing;

create table if not exists public.procurement_contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  numero text not null,
  ano integer not null,
  fornecedor text not null,
  fornecedor_documento text not null,
  objeto text not null,
  modalidade text not null,
  valor_total numeric(16,2) not null,
  valor_empenhado numeric(16,2) not null default 0,
  vigencia_inicio date not null,
  vigencia_fim date not null,
  status text not null default 'vigente',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_ano_check check (ano between 2000 and 2200),
  constraint contract_modalidade_check check (modalidade in (
    'pregao', 'concorrencia', 'concurso', 'leilao', 'dialogo_competitivo',
    'dispensa', 'inexigibilidade', 'credenciamento'
  )),
  constraint contract_status_check check (status in ('vigente', 'suspenso', 'encerrado', 'rescindido')),
  constraint contract_valor_pos check (valor_total > 0),
  constraint contract_empenhado_nonneg check (valor_empenhado >= 0),
  constraint contract_empenhado_teto check (valor_empenhado <= valor_total),
  constraint contract_vigencia_check check (vigencia_fim >= vigencia_inicio),
  constraint contract_fornecedor_not_blank check (btrim(fornecedor) <> ''),
  unique (tenant_id, ano, numero)
);

create index if not exists procurement_contracts_ano_idx
  on public.procurement_contracts (tenant_id, ano);

alter table public.procurement_contracts enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy contract_read on public.procurement_contracts for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.read'));
    create policy contract_manage on public.procurement_contracts for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.manage'))
      with check (private.has_tenant_permission(tenant_id, 'contracts.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.procurement_contracts to authenticated;
  end if;
end
$$;

commit;
