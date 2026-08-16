import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();

await db.exec(`
  create role authenticated;
  create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  create type public.app_role as enum ('funcionario', 'rh', 'admin');
  create type public.rh_permission as enum (
    'manage_employees','approve_documents','configure_schedules','close_payroll'
  );
  create type public.employee_status as enum ('ativo','ferias','afastado','desligado');
  create table public.profiles (
    id uuid primary key,
    full_name text, cpf text, matricula text, setor text, email text,
    cargo text, data_admissao date, status public.employee_status default 'ativo',
    salario numeric(12,2), centro_custo text,
    data_nascimento date, sexo text, estado_civil text, nome_mae text,
    email_pessoal text, celular text, rg text, pis_pasep text,
    cep text, logradouro text, numero_endereco text, complemento text,
    bairro text, cidade text, uf text,
    tipo_contrato text, regime_trabalho text, data_demissao date,
    jornada_semanal_horas numeric, unidade_id uuid,
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
    id uuid primary key default gen_random_uuid(), nome text not null, cnpj text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  alter table public.profiles add constraint profiles_unidade_legacy_fkey
    foreign key (unidade_id) references public.unidades(id);
  create function public.set_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end; $$;

  insert into public.unidades (id, nome)
  values ('20000000-0000-4000-8000-000000000001', 'Secretaria legada');
  insert into public.profiles
    (id, full_name, email, cpf, matricula, cargo, data_admissao, salario,
     centro_custo, tipo_contrato, regime_trabalho, jornada_semanal_horas, unidade_id)
  values
    ('10000000-0000-4000-8000-000000000001','Ana Servidora','ana@example.com',
     '123.456.789-01','MAT-001','Analista','2024-01-10',5000,'CC-01','Efetivo','Estatutário',40,
     '20000000-0000-4000-8000-000000000001'),
    ('10000000-0000-4000-8000-000000000002','Ana Cadastro Duplicado','ana2@example.com',
     '12345678901','MAT-002','Técnica','2024-02-10',4000,'CC-01','Efetivo','Estatutário',40,
     '20000000-0000-4000-8000-000000000001');
  insert into public.user_roles (user_id, role) values
    ('10000000-0000-4000-8000-000000000001','admin'),
    ('10000000-0000-4000-8000-000000000002','rh');
`);

for (const file of [
  "20260816150000_sprint1_multi_tenant_security.sql",
  "20260816190000_sprint2_people_scopes_audit.sql",
]) {
  const sql = await readFile(
    new URL(`../supabase/migrations/${file}`, import.meta.url),
    "utf8",
  );
  await db.exec(sql);
}

const tenant = (
  await db.query("select id from public.tenants order by created_at limit 1")
).rows[0];
const adminRole = (
  await db.query(
    "select id from public.security_roles where tenant_id=$1 and codigo='tenant_admin'",
    [tenant.id],
  )
).rows[0];
const rootUnit = "20000000-0000-4000-8000-000000000001";
const childUnit = "20000000-0000-4000-8000-000000000002";
await db.query(
  `insert into public.unidades (id, tenant_id, parent_id, codigo, nome, tipo)
   values ($1,$2,$3,'CHILD','Setor filho','setor')`,
  [childUnit, tenant.id, rootUnit],
);
const canonicalPerson = (
  await db.query("select id from public.persons order by created_at limit 1")
).rows[0].id;
await db.query(
  `insert into public.employment_links
     (tenant_id, person_id, registration_number, unit_id, status)
   values ($1,$2,'MAT-CHILD',$3,'rascunho')`,
  [tenant.id, canonicalPerson, childUnit],
);

// Substitui o escopo global do administrador por uma raiz com descendentes.
const assignment = (
  await db.query(
    `select id from public.security_user_roles
   where tenant_id=$1 and user_id='10000000-0000-4000-8000-000000000001' and role_id=$2 limit 1`,
    [tenant.id, adminRole.id],
  )
).rows[0];
await db.query(
  `insert into public.security_user_unit_scopes (user_role_id, unit_id, include_descendants)
   values ($1,$2,true)`,
  [assignment.id, rootUnit],
);
const scopedWithChildren = await db.query(
  `select unit_id from public.scoped_unit_ids($1,$2,'people.read') order by unit_id`,
  [tenant.id, "10000000-0000-4000-8000-000000000001"],
);
if (!scopedWithChildren.rows.some((row) => row.unit_id === childUnit))
  throw new Error("Validação falhou: descendente autorizado não foi incluído");

await db.query(
  "update public.security_user_unit_scopes set include_descendants=false where user_role_id=$1",
  [assignment.id],
);
const scopedLocal = await db.query(
  `select unit_id from public.scoped_unit_ids($1,$2,'people.read') order by unit_id`,
  [tenant.id, "10000000-0000-4000-8000-000000000001"],
);
if (scopedLocal.rows.some((row) => row.unit_id === childUnit))
  throw new Error("Validação falhou: escopo local incluiu descendente");

await db.exec(`
  select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
  set role authenticated;
`);
const localVisible = await db.query(
  "select count(*)::int as total from public.employment_links",
);
await db.exec("reset role");
if (localVisible.rows[0].total !== 2)
  throw new Error(
    "Validação falhou: RLS não restringiu o vínculo da unidade filha",
  );

await db.query(
  "update public.security_user_unit_scopes set include_descendants=true where user_role_id=$1",
  [assignment.id],
);
await db.exec("set role authenticated");
const descendantVisible = await db.query(
  "select count(*)::int as total from public.employment_links",
);
await db.exec("reset role");
if (descendantVisible.rows[0].total !== 3)
  throw new Error(
    "Validação falhou: RLS não liberou o vínculo descendente autorizado",
  );

let duplicateRegistrationGuard = false;
try {
  const personId = (await db.query("select id from public.persons limit 1"))
    .rows[0].id;
  await db.query(
    `insert into public.employment_links
       (tenant_id, person_id, registration_number, status)
     values ($1,$2,'MAT-001','rascunho')`,
    [tenant.id, personId],
  );
} catch (error) {
  duplicateRegistrationGuard = String(error).toLowerCase().includes("unique");
}
if (!duplicateRegistrationGuard)
  throw new Error("Validação falhou: matrícula duplicada não foi bloqueada");

await db.exec(`
  insert into public.tenants (id, codigo, nome)
  values ('30000000-0000-4000-8000-000000000001','SECOND','Segunda entidade');
  insert into public.unidades (id, tenant_id, codigo, nome, tipo)
  values ('30000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000001','OTHER','Unidade externa','unidade');
`);
let crossTenantGuard = false;
try {
  const personId = (await db.query("select id from public.persons limit 1"))
    .rows[0].id;
  await db.query(
    `insert into public.employment_links
       (tenant_id, person_id, registration_number, unit_id, status)
     values ($1,$2,'MAT-X',$3,'rascunho')`,
    [tenant.id, personId, "30000000-0000-4000-8000-000000000002"],
  );
} catch (error) {
  crossTenantGuard = String(error).includes("mesma entidade");
}
if (!crossTenantGuard)
  throw new Error(
    "Validação falhou: lotação de outro tenant não foi bloqueada",
  );

let activeDraftGuard = false;
try {
  const personId = (await db.query("select id from public.persons limit 1"))
    .rows[0].id;
  await db.query(
    `insert into public.employment_links
       (tenant_id, person_id, registration_number, status)
     values ($1,$2,'MAT-INCOMPLETE','ativo')`,
    [tenant.id, personId],
  );
} catch (error) {
  activeDraftGuard = String(error).includes("Vínculo ativo exige");
}
if (!activeDraftGuard)
  throw new Error(
    "Validação falhou: vínculo ativo incompleto não foi bloqueado",
  );

const result = await db.query(`
  select
    (select count(*)::int from public.profiles) as profiles,
    (select count(*)::int from public.profiles where person_id is not null) as profiles_linked,
    (select count(*)::int from public.persons) as persons,
    (select count(*)::int from public.tenant_memberships) as memberships,
    (select count(*)::int from public.employment_links) as employment_links,
    (select count(*)::int from public.security_permissions) as permissions
`);
const summary = {
  ...result.rows[0],
  cpf_deduplication: result.rows[0].persons === 1,
  reconciliation: result.rows[0].profiles === result.rows[0].profiles_linked,
  descendants_guard: true,
  rls_cross_scope_guard: true,
  duplicate_registration_guard: duplicateRegistrationGuard,
  cross_tenant_guard: crossTenantGuard,
  active_required_fields_guard: activeDraftGuard,
};
if (!summary.cpf_deduplication || !summary.reconciliation)
  throw new Error(`Validação falhou: ${JSON.stringify(summary)}`);

console.log(JSON.stringify(summary));
await db.close();
