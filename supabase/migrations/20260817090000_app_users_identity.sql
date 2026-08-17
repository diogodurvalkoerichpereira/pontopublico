-- Tabela de identidade própria da aplicação, que substituiu o auth.users do GoTrue.
--
-- Regularização de lacuna: a tabela é usada por src/lib/data.functions.ts desde a
-- Sprint 4 e por src/lib/auth.server.ts, mas nunca foi versionada. A Sprint 4
-- (20260817093000) faz "alter table public.app_users add column ...", o que aborta
-- a migration inteira num banco onde a tabela não existe, levando junto
-- private.auth_sessions e private.auth_login_attempts. Resultado: sem esta
-- migration, não há login.
--
-- O timestamp é imediatamente anterior ao da Sprint 4, de propósito.
--
-- As cinco colunas de endurecimento de login (failed_login_attempts, locked_until,
-- last_login_at, password_changed_at e force_password_change) permanecem na Sprint 4,
-- onde foram entregues, e são adicionadas lá com "add column if not exists".

begin;

create table if not exists public.app_users (
  id                 uuid primary key,
  email              text not null,
  password_hash      text not null,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint app_users_email_not_blank check (btrim(email) <> '')
);

-- Unicidade efetiva do login. A aplicação consulta "where lower(email) = $1" e
-- verifica duplicidade com um SELECT antes do INSERT (data.functions.ts:130 e :422),
-- o que é sujeito a corrida. O índice é a garantia real e também serve o lookup.
create unique index if not exists app_users_email_lower_uq
  on public.app_users (lower(email));

-- Nenhum cliente PostgREST acessa esta tabela: só o backend Node, como owner.
alter table public.app_users enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.app_users from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.app_users from authenticated;
  end if;
end $$;

commit;
