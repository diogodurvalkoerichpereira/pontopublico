import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
  requireCriticalMfa,
  type TenantPermission,
} from "./tenant-access.server";

export interface TenantSummary {
  id: string;
  codigo: string;
  nome: string;
  cnpj: string | null;
  timezone: string;
  is_default: boolean;
}

export interface TenantContextResult {
  tenants: TenantSummary[];
  activeTenant: TenantSummary | null;
  permissions: TenantPermission[];
  roleCodes: string[];
}

export interface OrganizationUnit {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  codigo: string;
  nome: string;
  tipo:
    | "entidade"
    | "secretaria"
    | "departamento"
    | "unidade"
    | "setor"
    | "centro_custo";
  ativo: boolean;
  ordem: number;
  cnpj: string | null;
}

const TenantIdInput = z.object({ tenant_id: z.string().uuid() });

function requestMetadata() {
  const request = getRequest();
  const forwarded = request?.headers
    ?.get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return {
    requestId: request?.headers?.get("x-request-id") ?? randomUUID(),
    ip: forwarded || null,
  };
}

async function audit(
  tenantId: string,
  actorId: string,
  action: string,
  resource: string,
  recordId: string | null,
  beforeData: unknown,
  afterData: unknown,
) {
  const meta = requestMetadata();
  await query(
    `insert into public.audit_events
       (tenant_id, actor_id, action, resource, record_id, before_data, after_data, request_id, ip)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::inet)`,
    [
      tenantId,
      actorId,
      action,
      resource,
      recordId,
      beforeData == null ? null : JSON.stringify(beforeData),
      afterData == null ? null : JSON.stringify(afterData),
      meta.requestId,
      meta.ip,
    ],
  );
}

export const getTenantContext = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) =>
    z
      .object({ active_tenant_id: z.string().uuid().nullable().optional() })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const tenants = await query<TenantSummary>(
      `select t.id, t.codigo, t.nome, t.cnpj, t.timezone, tm.is_default
       from public.tenant_memberships tm
       join public.tenants t on t.id = tm.tenant_id
       where tm.user_id = $1 and tm.status = 'ativo' and t.status = 'ativo'
       order by tm.is_default desc, t.nome`,
      [context.userId],
    );
    if (!tenants.length)
      return {
        tenants: [],
        activeTenant: null,
        permissions: [],
        roleCodes: [],
      };

    const activeTenant =
      tenants.find((tenant) => tenant.id === data.active_tenant_id) ??
      tenants.find((tenant) => tenant.is_default) ??
      tenants[0];
    const access = await loadTenantAccess(context.userId, activeTenant.id);
    return {
      tenants,
      activeTenant,
      permissions: access.permissions,
      roleCodes: access.roleCodes,
    } satisfies TenantContextResult;
  });

export const getOrganizationTree = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantIdInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "org.read");
    return query<OrganizationUnit>(
      `select id, tenant_id, parent_id, codigo, nome, tipo, ativo, ordem, cnpj
       from public.unidades
       where tenant_id = $1
       order by ordem, nome`,
      [data.tenant_id],
    );
  });

export const getTenantUsers = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantIdInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "security.read");
    return query<{
      id: string;
      full_name: string | null;
      email: string | null;
      cargo: string | null;
      setor: string | null;
      roles: string[];
      perms: string[];
    }>(
      `select p.id, p.full_name, p.email, p.cargo, p.setor,
         coalesce((select array_agg(ur.role::text) from public.user_roles ur where ur.user_id = p.id), '{}') as roles,
         coalesce((select array_agg(rp.permission::text) from public.rh_permissions rp where rp.user_id = p.id), '{}') as perms
       from public.tenant_memberships tm
       join public.profiles p on p.id = tm.user_id
       where tm.tenant_id = $1 and tm.status = 'ativo'
       order by p.full_name, p.email`,
      [data.tenant_id],
    );
  });

const SaveUnitInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  parent_id: z.string().uuid().nullable().optional(),
  codigo: z.string().trim().min(1).max(40),
  nome: z.string().trim().min(2).max(160),
  tipo: z.enum([
    "entidade",
    "secretaria",
    "departamento",
    "unidade",
    "setor",
    "centro_custo",
  ]),
  ativo: z.boolean().default(true),
  ordem: z.number().int().min(0).max(9999).default(0),
  cnpj: z.string().trim().max(20).nullable().optional(),
});

export const saveOrganizationUnit = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveUnitInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "org.manage");

    if (data.parent_id) {
      const parent = await queryOne<{ id: string }>(
        "select id from public.unidades where id = $1 and tenant_id = $2",
        [data.parent_id, data.tenant_id],
      );
      if (!parent) throw new Error("Unidade-pai inválida para esta entidade");
    }

    const duplicate = await queryOne<{ id: string }>(
      `select id from public.unidades
       where tenant_id = $1 and lower(codigo) = lower($2) and ($3::uuid is null or id <> $3)`,
      [data.tenant_id, data.codigo, data.id ?? null],
    );
    if (duplicate)
      throw new Error("Já existe uma unidade com este código na entidade");

    const before = data.id
      ? await queryOne<OrganizationUnit>(
          "select * from public.unidades where id = $1 and tenant_id = $2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Unidade não encontrada");

    const id = data.id ?? randomUUID();
    const rows = data.id
      ? await query<OrganizationUnit>(
          `update public.unidades set
             parent_id = $3, codigo = $4, nome = $5, tipo = $6, ativo = $7,
             ordem = $8, cnpj = $9, updated_at = now()
           where id = $1 and tenant_id = $2
           returning id, tenant_id, parent_id, codigo, nome, tipo, ativo, ordem, cnpj`,
          [
            id,
            data.tenant_id,
            data.parent_id ?? null,
            data.codigo,
            data.nome,
            data.tipo,
            data.ativo,
            data.ordem,
            data.cnpj || null,
          ],
        )
      : await query<OrganizationUnit>(
          `insert into public.unidades
             (id, tenant_id, parent_id, codigo, nome, tipo, ativo, ordem, cnpj)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning id, tenant_id, parent_id, codigo, nome, tipo, ativo, ordem, cnpj`,
          [
            id,
            data.tenant_id,
            data.parent_id ?? null,
            data.codigo,
            data.nome,
            data.tipo,
            data.ativo,
            data.ordem,
            data.cnpj || null,
          ],
        );
    const saved = rows[0];
    await audit(
      data.tenant_id,
      context.userId,
      data.id ? "update" : "create",
      "unidades",
      id,
      before,
      saved,
    );
    return saved;
  });

const CreateTenantInput = z.object({
  codigo: z.string().trim().min(2).max(40),
  nome: z.string().trim().min(2).max(160),
  cnpj: z.string().trim().max(20).nullable().optional(),
  timezone: z.string().trim().min(3).max(80).default("America/Sao_Paulo"),
});

export const createTenant = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CreateTenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const legacy = await queryOne<{ ok: boolean }>(
      `select exists(
         select 1 from public.user_roles where user_id = $1 and role::text = 'admin'
       ) as ok`,
      [context.userId],
    );
    if (!legacy?.ok)
      throw new Error("Apenas administradores gerais podem criar entidades");

    const duplicate = await queryOne<{ id: string }>(
      "select id from public.tenants where lower(codigo) = lower($1)",
      [data.codigo],
    );
    if (duplicate) throw new Error("Código de entidade já utilizado");

    const tenantId = randomUUID();
    await withTransaction(async (client) => {
      await client.query(
        `insert into public.tenants (id, codigo, nome, cnpj, timezone)
         values ($1,$2,$3,$4,$5)`,
        [tenantId, data.codigo, data.nome, data.cnpj || null, data.timezone],
      );
      await client.query(
        `insert into public.tenant_memberships (tenant_id, user_id, status, is_default)
         values ($1,$2,'ativo',false)`,
        [tenantId, context.userId],
      );
      await client.query(
        `insert into public.security_roles (tenant_id, codigo, nome, descricao, system_role)
         values
           ($1,'tenant_admin','Administrador da entidade','Administração completa da entidade',true),
           ($1,'sector_manager','Gestor setorial','Gestão operacional da estrutura',true),
           ($1,'auditor','Auditor','Consulta sem alteração',true),
           ($1,'employee','Servidor','Acesso básico do colaborador',true)`,
        [tenantId],
      );
      await client.query(
        `insert into public.security_role_permissions (role_id, permission_id)
         select r.id, p.id from public.security_roles r
         join public.security_permissions p on true
         where r.tenant_id = $1 and r.codigo = 'tenant_admin'`,
        [tenantId],
      );
      await client.query(
        `insert into public.security_role_permissions (role_id, permission_id)
         select r.id, p.id from public.security_roles r
         join public.security_permissions p on
           (r.codigo = 'sector_manager' and p.codigo in
             ('tenant.read','org.read','org.manage','security.read','people.read','people.manage','people.sensitive.read',
              'family.read','family.manage','movements.read','movements.manage','payroll.catalog.read','payroll.catalog.manage',
              'payroll.assignments.read','payroll.assignments.manage','payroll.simulate'))
           or (r.codigo = 'auditor' and p.codigo in
             ('tenant.read','org.read','security.read','audit.read','people.read',
              'family.read','movements.read','payroll.catalog.read','payroll.assignments.read','payroll.simulate'))
           or (r.codigo = 'employee' and p.codigo in ('tenant.read','org.read'))
         where r.tenant_id = $1
         on conflict do nothing`,
        [tenantId],
      );
      await client.query(
        `insert into public.security_user_roles (tenant_id, user_id, role_id, created_by)
         select $1, $2, id, $2 from public.security_roles
         where tenant_id = $1 and codigo = 'tenant_admin'`,
        [tenantId, context.userId],
      );
    });
    await audit(
      tenantId,
      context.userId,
      "create",
      "tenants",
      tenantId,
      null,
      data,
    );
    return { id: tenantId };
  });

export interface SecurityRoleView {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  system_role: boolean;
  ativo: boolean;
  permission_ids: string[];
}

export const getSecurityModel = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantIdInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "security.read");
    const [permissions, roles, users, assignments, scopes, units] =
      await Promise.all([
        query<{
          id: string;
          codigo: string;
          modulo: string;
          nome: string;
          criticidade: string;
        }>(
          "select id, codigo, modulo, nome, criticidade from public.security_permissions order by modulo, codigo",
        ),
        query<SecurityRoleView>(
          `select r.id, r.codigo, r.nome, r.descricao, r.system_role, r.ativo,
           coalesce(array_agg(rp.permission_id) filter (where rp.permission_id is not null), '{}') as permission_ids
         from public.security_roles r
         left join public.security_role_permissions rp on rp.role_id = r.id
         where r.tenant_id = $1
         group by r.id
         order by r.system_role desc, r.nome`,
          [data.tenant_id],
        ),
        query<{ id: string; full_name: string | null; email: string | null }>(
          `select p.id, p.full_name, p.email
         from public.tenant_memberships tm
         join public.profiles p on p.id = tm.user_id
         where tm.tenant_id = $1 and tm.status = 'ativo'
         order by p.full_name, p.email`,
          [data.tenant_id],
        ),
        query<{
          id: string;
          user_id: string;
          role_id: string;
          valid_from: string;
          valid_to: string | null;
          revoked_at: string | null;
          active: boolean;
        }>(
          `select id, user_id, role_id, valid_from::text, valid_to::text,
           revoked_at::text,
           (revoked_at is null and valid_from <= current_date
             and (valid_to is null or valid_to >= current_date)) as active
         from public.security_user_roles
         where tenant_id = $1
         order by created_at desc`,
          [data.tenant_id],
        ),
        query<{
          user_role_id: string;
          unit_id: string;
          include_descendants: boolean;
        }>(
          `select s.user_role_id, s.unit_id, s.include_descendants
         from public.security_user_unit_scopes s
         join public.security_user_roles ur on ur.id = s.user_role_id
         where ur.tenant_id = $1`,
          [data.tenant_id],
        ),
        query<{
          id: string;
          parent_id: string | null;
          codigo: string;
          nome: string;
          tipo: string;
        }>(
          `select id, parent_id, codigo, nome, tipo from public.unidades
         where tenant_id = $1 and ativo order by ordem, nome`,
          [data.tenant_id],
        ),
      ]);
    return {
      permissions,
      roles,
      users,
      assignments,
      scopes,
      units,
      canManage: access.permissions.includes("security.manage"),
    };
  });

const SaveRoleInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  codigo: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,39}$/),
  nome: z.string().trim().min(2).max(100),
  descricao: z.string().trim().max(500).nullable().optional(),
  permission_ids: z.array(z.string().uuid()).max(100),
});

export const saveSecurityRole = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveRoleInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "security.manage");
    requireCriticalMfa("security.manage", context.mfaVerifiedAt);
    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          "select * from public.security_roles where id = $1 and tenant_id = $2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Papel não encontrado");
    if (before?.system_role && before.codigo !== data.codigo) {
      throw new Error("O código de um papel do sistema não pode ser alterado");
    }

    const roleId = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.security_roles set codigo = $3, nome = $4, descricao = $5, updated_at = now()
           where id = $1 and tenant_id = $2`,
          [
            roleId,
            data.tenant_id,
            data.codigo,
            data.nome,
            data.descricao || null,
          ],
        );
      } else {
        await client.query(
          `insert into public.security_roles (id, tenant_id, codigo, nome, descricao)
           values ($1,$2,$3,$4,$5)`,
          [
            roleId,
            data.tenant_id,
            data.codigo,
            data.nome,
            data.descricao || null,
          ],
        );
      }
      await client.query(
        "delete from public.security_role_permissions where role_id = $1",
        [roleId],
      );
      if (data.permission_ids.length) {
        await client.query(
          `insert into public.security_role_permissions (role_id, permission_id)
           select $1, id from public.security_permissions where id = any($2::uuid[])`,
          [roleId, data.permission_ids],
        );
      }
    });
    const after = { id: roleId, ...data };
    await audit(
      data.tenant_id,
      context.userId,
      data.id ? "update" : "create",
      "security_roles",
      roleId,
      before,
      after,
    );
    return { id: roleId };
  });

const AssignRoleInput = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role_id: z.string().uuid(),
  assigned: z.boolean(),
});

export const assignSecurityRole = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => AssignRoleInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "security.manage");
    requireCriticalMfa("security.manage", context.mfaVerifiedAt);
    const role = await queryOne<{ codigo: string }>(
      "select codigo from public.security_roles where id = $1 and tenant_id = $2 and ativo",
      [data.role_id, data.tenant_id],
    );
    if (!role) throw new Error("Papel inválido");

    if (!data.assigned && role.codigo === "tenant_admin") {
      const count = await queryOne<{ total: string }>(
        `select count(distinct user_id)::text as total from public.security_user_roles
         where tenant_id = $1 and role_id = $2 and valid_from <= current_date
           and (valid_to is null or valid_to >= current_date)`,
        [data.tenant_id, data.role_id],
      );
      if (Number(count?.total ?? 0) <= 1)
        throw new Error("A entidade deve manter pelo menos um administrador");
    }

    if (data.assigned) {
      await query(
        `insert into public.security_user_roles (tenant_id, user_id, role_id, created_by)
         values ($1,$2,$3,$4) on conflict do nothing`,
        [data.tenant_id, data.user_id, data.role_id, context.userId],
      );
    } else {
      await query(
        `delete from public.security_user_roles
         where tenant_id = $1 and user_id = $2 and role_id = $3
           and valid_from <= current_date and (valid_to is null or valid_to >= current_date)`,
        [data.tenant_id, data.user_id, data.role_id],
      );
    }
    await audit(
      data.tenant_id,
      context.userId,
      data.assigned ? "assign" : "unassign",
      "security_user_roles",
      `${data.user_id}:${data.role_id}`,
      data.assigned ? null : data,
      data.assigned ? data : null,
    );
    return { ok: true };
  });

const SaveAssignmentInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role_id: z.string().uuid(),
  valid_from: z.string().date(),
  valid_to: z.string().date().nullable().optional(),
  revoked: z.boolean().optional().default(false),
  scopes: z
    .array(
      z.object({
        unit_id: z.string().uuid(),
        include_descendants: z.boolean(),
      }),
    )
    .max(200),
});

export const saveSecurityAssignment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveAssignmentInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "security.manage");
    requireCriticalMfa("security.manage", context.mfaVerifiedAt);
    if (data.valid_to && data.valid_to < data.valid_from)
      throw new Error("A vigência final não pode anteceder a inicial");

    const [role, membership] = await Promise.all([
      queryOne<{ id: string }>(
        "select id from public.security_roles where id=$1 and tenant_id=$2 and ativo",
        [data.role_id, data.tenant_id],
      ),
      queryOne<{ id: string }>(
        `select id from public.tenant_memberships
         where tenant_id=$1 and user_id=$2 and status='ativo'`,
        [data.tenant_id, data.user_id],
      ),
    ]);
    if (!role) throw new Error("Papel inválido para esta entidade");
    if (!membership)
      throw new Error("Usuário sem associação ativa com a entidade");

    if (data.scopes.length) {
      const validUnits = await query<{ id: string }>(
        "select id from public.unidades where tenant_id=$1 and id=any($2::uuid[]) and ativo",
        [data.tenant_id, data.scopes.map((scope) => scope.unit_id)],
      );
      if (
        validUnits.length !==
        new Set(data.scopes.map((scope) => scope.unit_id)).size
      )
        throw new Error("Há unidade inválida no escopo");
    }

    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          `select ur.*,
             coalesce((select jsonb_agg(to_jsonb(s)) from public.security_user_unit_scopes s where s.user_role_id=ur.id),'[]'::jsonb) as scopes
           from public.security_user_roles ur
           where ur.id=$1 and ur.tenant_id=$2`,
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Atribuição não encontrada");

    const assignmentId = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.security_user_roles set user_id=$3, role_id=$4,
             valid_from=$5, valid_to=$6,
             revoked_at=case when $7 then coalesce(revoked_at, now()) else null end,
             revoked_by=case when $7 then $8 else null end
           where id=$1 and tenant_id=$2`,
          [
            assignmentId,
            data.tenant_id,
            data.user_id,
            data.role_id,
            data.valid_from,
            data.valid_to || null,
            data.revoked,
            context.userId,
          ],
        );
      } else {
        await client.query(
          `insert into public.security_user_roles
             (id, tenant_id, user_id, role_id, valid_from, valid_to, created_by, revoked_at, revoked_by)
           values ($1,$2,$3,$4,$5,$6,$7,
             case when $8 then now() else null end,
             case when $8 then $7 else null end)`,
          [
            assignmentId,
            data.tenant_id,
            data.user_id,
            data.role_id,
            data.valid_from,
            data.valid_to || null,
            context.userId,
            data.revoked,
          ],
        );
      }
      await client.query(
        "delete from public.security_user_unit_scopes where user_role_id=$1",
        [assignmentId],
      );
      for (const scope of data.scopes) {
        await client.query(
          `insert into public.security_user_unit_scopes
             (user_role_id, unit_id, include_descendants)
           values ($1,$2,$3)`,
          [assignmentId, scope.unit_id, scope.include_descendants],
        );
      }
    });
    await audit(
      data.tenant_id,
      context.userId,
      data.id ? (data.revoked ? "revoke" : "update") : "assign",
      "security_user_roles",
      assignmentId,
      before,
      { ...data, id: assignmentId },
    );
    return { id: assignmentId };
  });
