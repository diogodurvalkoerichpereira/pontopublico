-- Emulação mínima da superfície Supabase (GoTrue, Storage, Realtime e roles do
-- PostgREST) para que as migrations herdadas apliquem sem edição em PostgreSQL puro.
--
-- Contexto: as migrations de 20260512 a 20260517 foram executadas num projeto
-- Supabase hospedado e referenciam auth.users, auth.uid(), os roles anon/
-- authenticated/service_role, storage.* e a publication supabase_realtime. O
-- projeto migrou para PostgreSQL próprio (src/lib/db.server.ts), mas o histórico
-- foi preservado: emula-se o que já executou em vez de reescrever a história.
--
-- Efeito colateral desejado: com os roles existindo, as policies de RLS passam a
-- ser criadas de fato. Sem este arquivo, os blocos "if to_regnamespace('auth')
-- is not null" viram no-op e o banco fica com RLS habilitada e zero policies.
--
-- NÃO aplicar em projeto Supabase real. Exige superusuário. Idempotente.

-- 1) Roles do PostgREST -------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- 2) Schemas ------------------------------------------------------------------
create schema if not exists auth;
create schema if not exists private;
create schema if not exists storage;

-- 3) auth.users existe apenas para satisfazer as cinco chaves estrangeiras da
--    primeira migration. Permanece vazia: a identidade real da aplicação é
--    public.app_users (ver 20260817090000_app_users_identity.sql).
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data  jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- 4) Funções auth.*, com as mesmas assinaturas do GoTrue. Sem JWT injetado,
--    auth.uid() retorna null e as policies negam por padrão (fail-closed).
create or replace function auth.uid() returns uuid language sql stable
  as $fn$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;

create or replace function auth.role() returns text language sql stable
  as $fn$ select nullif(current_setting('request.jwt.claim.role', true), '') $fn$;

create or replace function auth.email() returns text language sql stable
  as $fn$ select nullif(current_setting('request.jwt.claim.email', true), '') $fn$;

create or replace function auth.jwt() returns jsonb language sql stable
  as $fn$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $fn$;

-- 5) storage.*: apenas os objetos referenciados pelas migrations herdadas. Os
--    arquivos da aplicação vão para disco via STORAGE_DIR, não para estas tabelas.
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  owner              uuid,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text references storage.buckets(id),
  name             text,
  owner            uuid,
  metadata         jsonb,
  path_tokens      text[],
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_accessed_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[] language sql immutable
  as $fn$
    select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
  $fn$;

-- 6) Publication alvo do ALTER PUBLICATION em 20260513031752 ------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
