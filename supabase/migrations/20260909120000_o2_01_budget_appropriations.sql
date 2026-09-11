-- O2-01 (Onda 2 — núcleo SIAFIC) — Dotação orçamentária: a base do orçamento
-- público (LOA). Cada dotação é uma linha da despesa autorizada, classificada
-- pela estrutura orçamentária (unidade + função/subfunção + programa + ação +
-- natureza da despesa + fonte), com valor orçado e valor já empenhado. O saldo
-- (orçado - empenhado) é o que o empenho pode reservar. É a âncora que a
-- requisição de empenho da folha (O1-08) e a contabilidade PCASP passarão a
-- consumir. Ver ROADMAP_GESTAO_PUBLICA.md e ADR 0001.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

-- Permissões do módulo de orçamento.
insert into public.security_permissions (codigo, modulo, nome, criticidade)
values
  ('budget.read', 'orcamento', 'Consultar dotações orçamentárias', 'sensivel'),
  ('budget.manage', 'orcamento', 'Gerir dotações orçamentárias', 'critica')
on conflict (codigo) do update set nome = excluded.nome;

insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on p.codigo in ('budget.read', 'budget.manage')
where r.codigo = 'tenant_admin'
on conflict do nothing;

create table if not exists public.budget_appropriations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  unidade_orcamentaria text not null,
  funcao text not null,
  subfuncao text not null,
  programa text not null,
  acao text not null,
  natureza_despesa text not null,
  fonte_recurso text not null,
  valor_orcado numeric(16,2) not null,
  valor_empenhado numeric(16,2) not null default 0,
  status text not null default 'ativa',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_exercicio_check check (exercicio between 2000 and 2200),
  constraint budget_natureza_check check (natureza_despesa ~ '^[0-9.]{4,20}$'),
  constraint budget_status_check check (status in ('ativa', 'bloqueada', 'encerrada')),
  constraint budget_orcado_nonneg check (valor_orcado >= 0),
  constraint budget_empenhado_nonneg check (valor_empenhado >= 0),
  constraint budget_saldo_nonneg check (valor_empenhado <= valor_orcado)
);

-- Uma dotação por classificação completa no exercício (chave orçamentária).
create unique index if not exists budget_appropriations_key_uq
  on public.budget_appropriations (
    tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
    programa, acao, natureza_despesa, fonte_recurso
  );

create index if not exists budget_appropriations_exercicio_idx
  on public.budget_appropriations (tenant_id, exercicio);

alter table public.budget_appropriations enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy budget_read on public.budget_appropriations for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.read'));
    create policy budget_manage on public.budget_appropriations for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.manage'))
      with check (private.has_tenant_permission(tenant_id, 'budget.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.budget_appropriations to authenticated;
  end if;
end
$$;

commit;
