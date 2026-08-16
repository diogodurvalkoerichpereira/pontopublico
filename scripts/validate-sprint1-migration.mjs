import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();

await db.exec(`
  create role authenticated;
  create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

  create type public.app_role as enum ('funcionario', 'rh', 'admin');
  create type public.rh_permission as enum (
    'manage_employees','approve_documents','configure_schedules','close_payroll'
  );
  create table public.profiles (
    id uuid primary key,
    full_name text,
    email text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table public.user_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    role public.app_role not null,
    unique(user_id, role)
  );
  create table public.rh_permissions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete cascade,
    permission public.rh_permission not null,
    unique(user_id, permission)
  );
  create table public.unidades (
    id uuid primary key default gen_random_uuid(),
    nome text not null,
    cnpj text,
    cep text,
    logradouro text,
    numero text,
    complemento text,
    ponto_referencia text,
    uf text,
    estado text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create function public.set_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end; $$;

  insert into public.profiles (id, full_name, email)
  values ('11111111-1111-4111-8111-111111111111', 'Administrador', 'admin@example.com');
  insert into public.user_roles (user_id, role)
  values ('11111111-1111-4111-8111-111111111111', 'admin');
  insert into public.unidades (id, nome, cnpj)
  values ('22222222-2222-4222-8222-222222222222', 'Unidade legada', '12.345.678/0001-90');
`);

const migration = await readFile(
  new URL("../supabase/migrations/20260816150000_sprint1_multi_tenant_security.sql", import.meta.url),
  "utf8",
);
await db.exec(migration);

const tenantResult = await db.query("select id from public.tenants order by created_at limit 1");
const tenantId = tenantResult.rows[0].id;
await db.query(
  `insert into public.unidades (id, tenant_id, parent_id, codigo, nome, tipo)
   values ('33333333-3333-4333-8333-333333333333', $1,
     '22222222-2222-4222-8222-222222222222', 'CHILD', 'Unidade filha', 'setor')`,
  [tenantId],
);

let cycleGuard = false;
try {
  await db.exec(`
    update public.unidades
    set parent_id = '33333333-3333-4333-8333-333333333333'
    where id = '22222222-2222-4222-8222-222222222222'
  `);
} catch (error) {
  cycleGuard = String(error).includes("ciclo");
}
if (!cycleGuard) throw new Error("Validação falhou: ciclo organizacional não foi bloqueado");

await db.exec(`
  insert into public.tenants (id, codigo, nome)
  values ('44444444-4444-4444-8444-444444444444', 'SECOND', 'Segunda entidade');
  insert into public.security_roles (id, tenant_id, codigo, nome)
  values ('55555555-5555-4555-8555-555555555555',
    '44444444-4444-4444-8444-444444444444', 'employee', 'Servidor');
`);
let membershipGuard = false;
try {
  await db.exec(`
    insert into public.security_user_roles (tenant_id, user_id, role_id)
    values ('44444444-4444-4444-8444-444444444444',
      '11111111-1111-4111-8111-111111111111',
      '55555555-5555-4555-8555-555555555555')
  `);
} catch (error) {
  membershipGuard = String(error).includes("associação ativa");
}
if (!membershipGuard) throw new Error("Validação falhou: atribuição sem membership não foi bloqueada");

const result = await db.query(`
  select
    (select count(*)::int from public.tenants) as tenants,
    (select count(*)::int from public.tenant_memberships) as memberships,
    (select count(*)::int from public.security_permissions) as permissions,
    (select count(*)::int from public.security_roles) as roles,
    (select count(*)::int from public.security_user_roles) as assignments,
    (select count(*)::int from public.unidades where tenant_id is not null and codigo is not null) as migrated_units
`);

const summary = { ...result.rows[0], cycle_guard: cycleGuard, membership_guard: membershipGuard };
for (const [key, value] of Object.entries(summary)) {
  if (Number(value) < 1) throw new Error(`Validação falhou: ${key}=${value}`);
}

console.log(JSON.stringify(summary));
await db.close();
