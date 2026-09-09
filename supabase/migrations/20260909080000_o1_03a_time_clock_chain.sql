-- O1-03a — Registro de ponto imutavel e encadeado (base probatoria).
--
-- Hoje o ponto (time_entries) e user-scoped, sem numero sequencial e sem
-- encadeamento: nao ha como provar que uma marcacao nao foi inserida ou alterada
-- depois. Esta migration cria a base probatoria: marcacoes multi-tenant, append-
-- only, com NSR sequencial por ente e encadeamento SHA-256 (cada marcacao carrega
-- o hash da anterior), de modo que qualquer adulteracao quebra a cadeia.
--
-- ESCOPO: base interna. NAO produz AFD/AEJ nem declara conformidade com a Portaria
-- MTP 671/2021 — isso exige homologacao por ferramenta oficial (O1-03b). Ver
-- src/lib/conformance.ts e a regra do CLAUDE.md.
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.time_clock_punches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  employment_link_id uuid not null references public.employment_links(id) on delete restrict,
  nsr bigint not null,
  punch_time timestamptz not null,
  source text not null default 'manual',
  previous_hash char(64) not null,
  record_hash char(64) not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint time_clock_punches_nsr_check check (nsr > 0),
  constraint time_clock_punches_prev_hash_format check (previous_hash ~ '^[0-9a-f]{64}$'),
  constraint time_clock_punches_hash_format check (record_hash ~ '^[0-9a-f]{64}$'),
  constraint time_clock_punches_nsr_uq unique (tenant_id, nsr),
  constraint time_clock_punches_hash_uq unique (tenant_id, record_hash)
);

create index if not exists time_clock_punches_link_idx
  on public.time_clock_punches (tenant_id, employment_link_id, punch_time);

-- Contador por ente: a linha e travada com FOR UPDATE ao gravar, serializando a
-- geracao de NSR e do encadeamento (evita corrida na tabela quente de marcacoes).
create table if not exists public.time_clock_counters (
  tenant_id uuid primary key references public.tenants(id) on delete restrict,
  last_nsr bigint not null default 0,
  last_hash char(64) not null default '0000000000000000000000000000000000000000000000000000000000000000',
  updated_at timestamptz not null default now()
);

-- Coerencia: a marcacao pertence a um vinculo da mesma entidade.
create or replace function public.validate_time_clock_punch()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  link_tenant uuid;
begin
  select tenant_id into link_tenant from public.employment_links where id = new.employment_link_id;
  if link_tenant is null or link_tenant <> new.tenant_id then
    raise exception 'O vinculo da marcacao deve pertencer a mesma entidade';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_time_clock_punch on public.time_clock_punches;
create trigger trg_validate_time_clock_punch
  before insert on public.time_clock_punches
  for each row execute function public.validate_time_clock_punch();

-- Imutabilidade: a marcacao e append-only. Todo UPDATE/DELETE e recusado — a
-- correcao de ponto se faz por nova marcacao encadeada, nunca in-place.
create or replace function public.block_time_clock_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Marcacao de ponto e imutavel (append-only)';
end;
$$;

drop trigger if exists trg_block_time_clock_mutation on public.time_clock_punches;
create trigger trg_block_time_clock_mutation
  before update or delete on public.time_clock_punches
  for each row execute function public.block_time_clock_mutation();

alter table public.time_clock_punches enable row level security;
alter table public.time_clock_counters enable row level security;

-- Politicas so no ambiente Supabase (auth.*). Leitura por people.read, registro
-- por people.manage; nunca update/delete (a imutabilidade e do trigger tambem). O
-- contador nao tem politica publica: e uso server-side.
do $$
begin
  if to_regnamespace('auth') is not null then
    create policy time_clock_punches_read on public.time_clock_punches for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'people.read'));
    create policy time_clock_punches_insert on public.time_clock_punches for insert to authenticated
      with check (private.has_tenant_permission(tenant_id, 'people.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert on public.time_clock_punches to authenticated;
  end if;
end
$$;

commit;
