import { query, queryOne } from "./db.server";
import { loadAccess } from "./pgrest.server";

export const TENANT_PERMISSION_CODES = [
  "tenant.read",
  "tenant.manage",
  "org.read",
  "org.manage",
  "security.read",
  "security.manage",
  "audit.read",
  "people.read",
  "people.manage",
  "people.sensitive.read",
  "family.read",
  "family.manage",
  "movements.read",
  "movements.manage",
  "payroll.catalog.read",
  "payroll.catalog.manage",
  "payroll.assignments.read",
  "payroll.assignments.manage",
  "payroll.simulate",
  "payroll.cycles.read",
  "payroll.cycles.prepare",
  "payroll.cycles.approve",
  "payroll.cycles.close",
  "payroll.cycles.reopen",
  "payroll.special.read",
  "payroll.special.manage",
  "employment.special.read",
  "employment.special.manage",
  "termination.read",
  "termination.manage",
  "vacation.read",
  "vacation.manage",
  "payroll.import.read",
  "payroll.import.manage",
  "bank.remittance.read",
  "bank.remittance.manage",
  "official.export.read",
  "official.export.manage",
  "esocial.read",
  "esocial.manage",
  "manager.dashboard.read",
  "mobile.push.manage",
  "analytics.read",
  "analytics.manage",
  "fiscal.read",
  "fiscal.manage",
  "ai.analytics.use",
  "support.use",
  "migration.read",
  "migration.manage",
] as const;

export type TenantPermission = (typeof TENANT_PERMISSION_CODES)[number];

export interface TenantAccess {
  userId: string;
  tenantId: string;
  permissions: TenantPermission[];
  roleCodes: string[];
  legacyAdmin: boolean;
}

export async function loadTenantAccess(
  userId: string,
  tenantId: string,
): Promise<TenantAccess> {
  const membership = await queryOne<{ id: string }>(
    `select id from public.tenant_memberships
     where tenant_id = $1 and user_id = $2 and status = 'ativo'`,
    [tenantId, userId],
  );
  if (!membership)
    throw new Error("Usuário sem associação ativa com a entidade");

  const [roleRows, permissionRows, legacy] = await Promise.all([
    query<{ codigo: string }>(
      `select distinct r.codigo
       from public.security_user_roles ur
       join public.security_roles r on r.id = ur.role_id and r.tenant_id = ur.tenant_id
       where ur.tenant_id = $1 and ur.user_id = $2
         and ur.valid_from <= current_date
         and (ur.valid_to is null or ur.valid_to >= current_date)
         and ur.revoked_at is null
         and r.ativo`,
      [tenantId, userId],
    ),
    query<{ codigo: TenantPermission }>(
      `select distinct p.codigo
       from public.security_user_roles ur
       join public.security_roles r on r.id = ur.role_id and r.tenant_id = ur.tenant_id and r.ativo
       join public.security_role_permissions rp on rp.role_id = r.id
       join public.security_permissions p on p.id = rp.permission_id
       where ur.tenant_id = $1 and ur.user_id = $2
         and ur.valid_from <= current_date
         and (ur.valid_to is null or ur.valid_to >= current_date)
         and ur.revoked_at is null`,
      [tenantId, userId],
    ),
    loadAccess(userId),
  ]);

  const legacyAdmin = legacy.roles.includes("admin");
  const permissions = new Set<TenantPermission>(
    permissionRows.map((row) => row.codigo),
  );

  // Compatibilidade durante a transição dos papéis legados.
  if (legacyAdmin)
    TENANT_PERMISSION_CODES.forEach((code) => permissions.add(code));
  if (legacy.roles.includes("rh")) {
    permissions.add("tenant.read");
    permissions.add("org.read");
    permissions.add("security.read");
    permissions.add("people.read");
    permissions.add("people.sensitive.read");
    permissions.add("family.read");
    permissions.add("movements.read");
    permissions.add("payroll.catalog.read");
    permissions.add("payroll.assignments.read");
    permissions.add("payroll.cycles.read");
    permissions.add("payroll.special.read");
    permissions.add("employment.special.read");
    permissions.add("termination.read");
    permissions.add("vacation.read");
    permissions.add("payroll.import.read");
    permissions.add("bank.remittance.read");
    permissions.add("official.export.read");
    permissions.add("esocial.read");
    permissions.add("manager.dashboard.read");
    permissions.add("analytics.read");
    permissions.add("fiscal.read");
    permissions.add("ai.analytics.use");
    permissions.add("support.use");
  }
  if (legacy.perms.includes("manage_employees")) {
    permissions.add("org.manage");
    permissions.add("people.read");
    permissions.add("people.manage");
    permissions.add("people.sensitive.read");
    permissions.add("family.read");
    permissions.add("family.manage");
    permissions.add("movements.read");
    permissions.add("movements.manage");
    permissions.add("payroll.catalog.read");
    permissions.add("payroll.assignments.read");
    permissions.add("payroll.assignments.manage");
  }
  if (legacy.perms.includes("close_payroll")) {
    permissions.add("payroll.catalog.read");
    permissions.add("payroll.catalog.manage");
    permissions.add("payroll.assignments.read");
    permissions.add("payroll.assignments.manage");
    permissions.add("payroll.simulate");
    permissions.add("payroll.cycles.read");
    permissions.add("payroll.cycles.prepare");
    permissions.add("payroll.cycles.approve");
    permissions.add("payroll.cycles.close");
    permissions.add("payroll.cycles.reopen");
    permissions.add("payroll.special.read");
    permissions.add("payroll.special.manage");
    permissions.add("employment.special.read");
    permissions.add("employment.special.manage");
    permissions.add("termination.read");
    permissions.add("termination.manage");
    permissions.add("vacation.read");
    permissions.add("vacation.manage");
    permissions.add("payroll.import.read");
    permissions.add("payroll.import.manage");
    permissions.add("bank.remittance.read");
    permissions.add("bank.remittance.manage");
    permissions.add("official.export.read");
    permissions.add("official.export.manage");
    permissions.add("esocial.read");
    permissions.add("esocial.manage");
    permissions.add("manager.dashboard.read");
    permissions.add("mobile.push.manage");
    permissions.add("analytics.read");
    permissions.add("analytics.manage");
    permissions.add("fiscal.read");
    permissions.add("fiscal.manage");
    permissions.add("ai.analytics.use");
    permissions.add("support.use");
    permissions.add("migration.read");
    permissions.add("migration.manage");
  }

  return {
    userId,
    tenantId,
    permissions: [...permissions],
    roleCodes: roleRows.map((row) => row.codigo),
    legacyAdmin,
  };
}

export interface TenantUnitScope {
  global: boolean;
  unitIds: string[];
}

export async function loadTenantUnitScope(
  access: TenantAccess,
  permission: TenantPermission,
): Promise<TenantUnitScope> {
  requireTenantPermission(access, permission);
  const [units, globalRow] = await Promise.all([
    query<{ unit_id: string }>(
      "select unit_id from public.scoped_unit_ids($1,$2,$3)",
      [access.tenantId, access.userId, permission],
    ),
    queryOne<{ ok: boolean }>(
      `select exists(
         select 1
         from public.security_user_roles ur
         join public.security_roles r on r.id = ur.role_id and r.ativo
         join public.security_role_permissions rp on rp.role_id = r.id
         join public.security_permissions p on p.id = rp.permission_id and p.codigo = $3
         where ur.tenant_id = $1 and ur.user_id = $2
           and ur.valid_from <= current_date
           and (ur.valid_to is null or ur.valid_to >= current_date)
           and ur.revoked_at is null
           and not exists (
             select 1 from public.security_user_unit_scopes s where s.user_role_id = ur.id
           )
       ) as ok`,
      [access.tenantId, access.userId, permission],
    ),
  ]);
  return {
    global: Boolean(globalRow?.ok),
    unitIds: units.map((row) => row.unit_id),
  };
}

export function requireUnitInScope(
  scope: TenantUnitScope,
  unitId: string | null,
) {
  if (scope.global) return;
  if (!unitId || !scope.unitIds.includes(unitId)) {
    throw new Error("Unidade fora do escopo organizacional do usuário");
  }
}

export function requireTenantPermission(
  access: TenantAccess,
  permission: TenantPermission,
) {
  if (!access.permissions.includes(permission)) {
    throw new Error(`Sem permissão: ${permission}`);
  }
}

/**
 * Invólucro fail-closed para o corpo de uma server function: valida a associação
 * ao ente (lança se o usuário não for membro), exige a permissão e só então roda
 * `fn` com o `TenantAccess` resolvido. É o caminho recomendado para todo handler
 * novo — reúne numa chamada as duas linhas que, esquecidas, abrem o tenant
 * inteiro (ver CLAUDE.md). O teste `tests/authorization-coverage.test.mjs`
 * reconhece este helper como cobertura de autorização.
 */
export async function withTenant<T>(
  userId: string,
  tenantId: string,
  permission: TenantPermission,
  fn: (access: TenantAccess) => Promise<T>,
): Promise<T> {
  const access = await loadTenantAccess(userId, tenantId);
  requireTenantPermission(access, permission);
  return fn(access);
}
