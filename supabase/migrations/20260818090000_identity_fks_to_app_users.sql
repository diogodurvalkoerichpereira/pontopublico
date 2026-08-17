-- Reaponta para public.app_users as chaves estrangeiras que ainda referenciam
-- auth.users, e desliga o trigger de provisionamento do GoTrue.
--
-- Motivo: a autenticação passou a ser própria (src/lib/auth.server.ts e
-- src/lib/data.functions.ts). auth.users existe apenas como emulação vazia
-- (db/bootstrap/000_supabase_compat.sql) para satisfazer o DDL herdado. Enquanto
-- as FKs apontarem para lá, o primeiro cadastro falha com profiles_id_fkey, porque
-- signUp insere em app_users e em profiles, e nunca em auth.users.
--
-- Ações referenciais: cascade nas três referências de posse (profiles.id,
-- user_roles.user_id e atestados.user_id), como já estava declarado na migration
-- 20260512020732. Nas duas referências opcionais (atestados.reviewed_by e
-- audit_logs.actor_id) adota-se "set null" em vez do NO ACTION original: ambas as
-- colunas já são anuláveis, e manter NO ACTION tornaria a exclusão de usuário
-- impossível na prática, já que audit_logs.actor_id referencia quase todo usuário.
-- A alternativa descartada foi não criar FK alguma, o que preservaria o
-- comportamento atual de deixar registros órfãos apontando para usuário inexistente.

begin;

-- 1) Remove toda FK que ainda aponte para auth.users
do $$
declare
  r record;
begin
  for r in
    select con.conname, nsp.nspname, rel.relname
      from pg_constraint con
      join pg_class     rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      join pg_class     fre on fre.oid = con.confrelid
      join pg_namespace frn on frn.oid = fre.relnamespace
     where con.contype = 'f'
       and frn.nspname = 'auth'
       and fre.relname = 'users'
  loop
    execute format('alter table %I.%I drop constraint %I', r.nspname, r.relname, r.conname);
  end loop;
end $$;

-- 2) Recria com o mesmo nome, agora contra a identidade real
do $$
begin
  if to_regclass('public.app_users') is null then
    raise exception 'public.app_users ausente: aplique 20260817090000_app_users_identity.sql antes';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'profiles_id_fkey') then
    alter table public.profiles
      add constraint profiles_id_fkey
      foreign key (id) references public.app_users(id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'user_roles_user_id_fkey') then
    alter table public.user_roles
      add constraint user_roles_user_id_fkey
      foreign key (user_id) references public.app_users(id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'atestados_user_id_fkey') then
    alter table public.atestados
      add constraint atestados_user_id_fkey
      foreign key (user_id) references public.app_users(id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'atestados_reviewed_by_fkey') then
    alter table public.atestados
      add constraint atestados_reviewed_by_fkey
      foreign key (reviewed_by) references public.app_users(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'audit_logs_actor_id_fkey') then
    alter table public.audit_logs
      add constraint audit_logs_actor_id_fkey
      foreign key (actor_id) references public.app_users(id) on delete set null;
  end if;
end $$;

-- 3) handle_new_user() insere em public.profiles sem ON CONFLICT
--    (20260512020732:107). Com a identidade em app_users, qualquer escrita em
--    auth.users criaria profile órfão ou colidiria com o insert do próprio signUp.
drop trigger if exists on_auth_user_created on auth.users;

commit;
