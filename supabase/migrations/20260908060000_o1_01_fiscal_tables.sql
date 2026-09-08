-- O1-01 — Tabelas fiscais versionadas (INSS/IRRF/RPPS) para o nó table_lookup.
--
-- As faixas fiscais saem do singleton global payroll_config para tabelas
-- versionadas por vigencia e por ente. tenant_id NULO = tabela NACIONAL (INSS e
-- IRRF federais, iguais para todo municipio); tenant_id preenchido = tabela do
-- ente (RPPS, O1-02). O avaliador de formula (payroll-formula.ts) recebe estas
-- versoes pre-carregadas num Map e continua funcao pura, sem I/O. O id e o
-- checksum da versao entram na memoria de calculo. Ver ADR 0003 e src/lib/
-- fiscal-tables.server.ts. Espelha o vocabulario de payroll_rubric_versions.
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.fiscal_tables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete restrict,
  code text not null,
  name text not null,
  status text not null default 'ativo',
  description text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_tables_code_not_blank check (btrim(code) <> ''),
  constraint fiscal_tables_code_format check (code ~ '^[A-Z0-9_]+$'),
  constraint fiscal_tables_status_check check (status in ('ativo', 'inativo'))
);

-- Unicidade do codigo por ente; as nacionais (tenant nulo) partilham um bucket.
create unique index if not exists fiscal_tables_scope_code_uq
  on public.fiscal_tables (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(code));

create table if not exists public.fiscal_table_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete restrict,
  fiscal_table_id uuid not null references public.fiscal_tables(id) on delete restrict,
  version_number integer not null,
  valid_from date not null,
  valid_to date,
  status text not null default 'rascunho',
  brackets jsonb not null,
  checksum text not null,
  published_at timestamptz,
  published_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_versions_number_check check (version_number > 0),
  constraint fiscal_versions_validity_check check (valid_to is null or valid_to >= valid_from),
  constraint fiscal_versions_status_check check (status in ('rascunho', 'publicada', 'arquivada')),
  constraint fiscal_versions_checksum_check check (checksum ~ '^[0-9a-f]{64}$'),
  constraint fiscal_versions_uq unique (fiscal_table_id, version_number)
);

create index if not exists fiscal_versions_validity_idx
  on public.fiscal_table_versions (fiscal_table_id, status, valid_from, valid_to);

-- Coerencia de ente e nao-sobreposicao de vigencias publicadas (por tabela).
-- Usa `is distinct from` para tratar o ente NULO (nacional) como valor legitimo.
create or replace function public.validate_fiscal_table_version()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  table_tenant uuid;
begin
  select tenant_id into table_tenant from public.fiscal_tables where id = new.fiscal_table_id;
  if not found then
    raise exception 'Tabela fiscal inexistente';
  end if;
  if table_tenant is distinct from new.tenant_id then
    raise exception 'A versao deve pertencer a mesma entidade da tabela fiscal';
  end if;
  if new.status = 'publicada' and exists (
    select 1 from public.fiscal_table_versions current_version
    where current_version.fiscal_table_id = new.fiscal_table_id
      and current_version.status = 'publicada'
      and current_version.id <> new.id
      and daterange(current_version.valid_from, coalesce(current_version.valid_to + 1, 'infinity'::date), '[)')
          && daterange(new.valid_from, coalesce(new.valid_to + 1, 'infinity'::date), '[)')
  ) then
    raise exception 'A vigencia publicada se sobrepoe a outra versao da tabela fiscal';
  end if;
  if new.status = 'publicada' then
    new.published_at := coalesce(new.published_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_fiscal_table_version on public.fiscal_table_versions;
create trigger trg_validate_fiscal_table_version
  before insert or update of tenant_id, fiscal_table_id, valid_from, valid_to, status
  on public.fiscal_table_versions
  for each row execute function public.validate_fiscal_table_version();

alter table public.fiscal_tables enable row level security;
alter table public.fiscal_table_versions enable row level security;

-- Politicas so no ambiente Supabase (auth.*); no backend proprio a leitura corre
-- server-side como dono. Tabelas nacionais (tenant nulo) sao legiveis por todos;
-- as do ente respeitam fiscal.read/manage. Nacional nao e gerida pela app.
do $$
begin
  if to_regnamespace('auth') is not null then
    create policy fiscal_tables_read on public.fiscal_tables for select to authenticated
      using (tenant_id is null or private.has_tenant_permission(tenant_id, 'fiscal.read'));
    create policy fiscal_tables_manage on public.fiscal_tables for all to authenticated
      using (tenant_id is not null and private.has_tenant_permission(tenant_id, 'fiscal.manage'))
      with check (tenant_id is not null and private.has_tenant_permission(tenant_id, 'fiscal.manage'));
    create policy fiscal_versions_read on public.fiscal_table_versions for select to authenticated
      using (tenant_id is null or private.has_tenant_permission(tenant_id, 'fiscal.read'));
    create policy fiscal_versions_manage on public.fiscal_table_versions for all to authenticated
      using (tenant_id is not null and private.has_tenant_permission(tenant_id, 'fiscal.manage'))
      with check (tenant_id is not null and private.has_tenant_permission(tenant_id, 'fiscal.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.fiscal_tables to authenticated;
    grant select, insert, update on public.fiscal_table_versions to authenticated;
  end if;
end
$$;

-- Seed das tabelas federais (nacionais, tenant nulo), vigentes desde 2025-01-01.
-- Faixas 2025 hoje default de payroll_config; checksum pre-computado com o mesmo
-- canonizador de src/lib/payroll-formula.server.ts (o loader reconfere).
insert into public.fiscal_tables (id, tenant_id, code, name, description)
values ('f1541b1e-0000-4000-8000-000000000001', null, 'INSS_FEDERAL', 'INSS - contribuicao progressiva federal', 'Faixas federais do INSS (modo progressive).')
on conflict do nothing;

insert into public.fiscal_tables (id, tenant_id, code, name, description)
values ('f1541b1e-0000-4000-8000-000000000002', null, 'IRRF_FEDERAL', 'IRRF - tabela progressiva federal', 'Faixas federais do IRRF (modo bracket, com parcela a deduzir).')
on conflict do nothing;

insert into public.fiscal_table_versions (id, tenant_id, fiscal_table_id, version_number, valid_from, status, brackets, checksum)
values (
  'f1541b1e-0000-4000-8000-000000000011', null, 'f1541b1e-0000-4000-8000-000000000001', 1, '2025-01-01', 'publicada',
  '[{"ate":1518,"aliquota":0.075},{"ate":2793.88,"aliquota":0.09},{"ate":4190.83,"aliquota":0.12},{"ate":8157.41,"aliquota":0.14}]'::jsonb,
  '8a8683b1fe89704ed2b2e3aefcdc1bf7df282bf0da566f28be7f3640de785ac4'
)
on conflict do nothing;

insert into public.fiscal_table_versions (id, tenant_id, fiscal_table_id, version_number, valid_from, status, brackets, checksum)
values (
  'f1541b1e-0000-4000-8000-000000000012', null, 'f1541b1e-0000-4000-8000-000000000002', 1, '2025-01-01', 'publicada',
  '[{"ate":2428.80,"aliquota":0,"deduzir":0},{"ate":2826.65,"aliquota":0.075,"deduzir":182.16},{"ate":3751.05,"aliquota":0.15,"deduzir":394.16},{"ate":4664.68,"aliquota":0.225,"deduzir":675.49},{"ate":999999999,"aliquota":0.275,"deduzir":908.73}]'::jsonb,
  '44335008d810fe710d55fdb26764a326e4bc5edd4e38e5618080c6199165b68e'
)
on conflict do nothing;

commit;
