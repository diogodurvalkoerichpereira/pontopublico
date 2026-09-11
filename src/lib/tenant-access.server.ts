import { query, queryOne } from "./db.server";
import { loadAccess } from "./pgrest.server";

// Ponte de compatibilidade dos papéis legados (user_roles/rh_permissions). Ligada
// por padrão para não retirar acesso de ninguém no deploy; a telemetria abaixo
// mede quem ainda depende dela. Vira "off" numa etapa só de env quando a
// dependência zerar (O0-10, Incremento 2). Ver ADR 0014.
const LEGACY_ROLE_BRIDGE = (process.env.LEGACY_ROLE_BRIDGE ?? "on") !== "off";

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
  "budget.read",
  "budget.manage",
  "accounting.read",
  "accounting.manage",
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

  // Fonte de verdade: as permissões vindas do RBAC por tenant.
  const rbac = new Set<TenantPermission>(
    permissionRows.map((row) => row.codigo),
  );
  const permissions = new Set<TenantPermission>(rbac);

  // O que a ponte legada *acrescentaria*, calculado num conjunto à parte para
  // saber exatamente o que só ela concede (vs. o que o RBAC já dá).
  const bridged = computeLegacyBridge(legacy);

  const bridgeOnly = [...bridged].filter((code) => !rbac.has(code));
  if (bridgeOnly.length > 0) {
    // Telemetria: registra sempre (on ou off) quem ainda depende da ponte, para
    // que virar LEGACY_ROLE_BRIDGE=off seja observável. Barato, sem tocar o banco.
    console.warn(
      JSON.stringify({
        tag: "LEGACY_BRIDGE_DEPENDENCY",
        bridgeEnabled: LEGACY_ROLE_BRIDGE,
        userId,
        tenantId,
        legacyAdmin,
        bridgeOnlyPermissions: bridgeOnly,
      }),
    );
  }

  if (LEGACY_ROLE_BRIDGE) bridged.forEach((code) => permissions.add(code));

  return {
    userId,
    tenantId,
    permissions: [...permissions],
    roleCodes: roleRows.map((row) => row.codigo),
    legacyAdmin,
  };
}

interface LegacyAccess {
  roles: string[];
  perms: string[];
}

/**
 * Permissões que a ponte legada concede a partir de user_roles/rh_permissions.
 * Isolada do caminho do RBAC de propósito (O0-10): é o que O0-10 aposenta. A
 * migration de reconciliação materializa exatamente estes conjuntos em papéis
 * reais (tenant_admin já tem o catálogo; rh_operador recebe a união rh +
 * manage_employees + close_payroll).
 */
function computeLegacyBridge(legacy: LegacyAccess): Set<TenantPermission> {
  const bridged = new Set<TenantPermission>();
  if (legacy.roles.includes("admin"))
    TENANT_PERMISSION_CODES.forEach((code) => bridged.add(code));
  if (legacy.roles.includes("rh")) {
    bridged.add("tenant.read");
    bridged.add("org.read");
    bridged.add("security.read");
    bridged.add("people.read");
    bridged.add("people.sensitive.read");
    bridged.add("family.read");
    bridged.add("movements.read");
    bridged.add("payroll.catalog.read");
    bridged.add("payroll.assignments.read");
    bridged.add("payroll.cycles.read");
    bridged.add("payroll.special.read");
    bridged.add("employment.special.read");
    bridged.add("termination.read");
    bridged.add("vacation.read");
    bridged.add("payroll.import.read");
    bridged.add("bank.remittance.read");
    bridged.add("official.export.read");
    bridged.add("esocial.read");
    bridged.add("manager.dashboard.read");
    bridged.add("analytics.read");
    bridged.add("fiscal.read");
    bridged.add("ai.analytics.use");
    bridged.add("support.use");
  }
  if (legacy.perms.includes("manage_employees")) {
    bridged.add("org.manage");
    bridged.add("people.read");
    bridged.add("people.manage");
    bridged.add("people.sensitive.read");
    bridged.add("family.read");
    bridged.add("family.manage");
    bridged.add("movements.read");
    bridged.add("movements.manage");
    bridged.add("payroll.catalog.read");
    bridged.add("payroll.assignments.read");
    bridged.add("payroll.assignments.manage");
  }
  if (legacy.perms.includes("close_payroll")) {
    bridged.add("payroll.catalog.read");
    bridged.add("payroll.catalog.manage");
    bridged.add("payroll.assignments.read");
    bridged.add("payroll.assignments.manage");
    bridged.add("payroll.simulate");
    bridged.add("payroll.cycles.read");
    bridged.add("payroll.cycles.prepare");
    bridged.add("payroll.cycles.approve");
    bridged.add("payroll.cycles.close");
    bridged.add("payroll.cycles.reopen");
    bridged.add("payroll.special.read");
    bridged.add("payroll.special.manage");
    bridged.add("employment.special.read");
    bridged.add("employment.special.manage");
    bridged.add("termination.read");
    bridged.add("termination.manage");
    bridged.add("vacation.read");
    bridged.add("vacation.manage");
    bridged.add("payroll.import.read");
    bridged.add("payroll.import.manage");
    bridged.add("bank.remittance.read");
    bridged.add("bank.remittance.manage");
    bridged.add("official.export.read");
    bridged.add("official.export.manage");
    bridged.add("esocial.read");
    bridged.add("esocial.manage");
    bridged.add("manager.dashboard.read");
    bridged.add("mobile.push.manage");
    bridged.add("analytics.read");
    bridged.add("analytics.manage");
    bridged.add("fiscal.read");
    bridged.add("fiscal.manage");
    bridged.add("ai.analytics.use");
    bridged.add("support.use");
    bridged.add("migration.read");
    bridged.add("migration.manage");
    bridged.add("budget.read");
    bridged.add("budget.manage");
    bridged.add("accounting.read");
    bridged.add("accounting.manage");
  }
  return bridged;
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
 * Permissões que, por serem atos de alto risco e em geral irreversíveis, exigem
 * segundo fator (TOTP) além da senha. Conjunto restrito de propósito (O0-09): a
 * maioria das permissões `critica` é de rotina do RH; exigir MFA em todas
 * tornaria o segundo fator onipresente. Ver src/lib/mfa.server.ts.
 */
export const PROTECTED_MFA_PERMISSIONS: ReadonlySet<TenantPermission> = new Set(
  [
    "security.manage",
    "tenant.manage",
    "payroll.cycles.close",
    "payroll.cycles.reopen",
  ],
);

/**
 * Guard fail-closed do segundo fator. Se `permission` está no conjunto protegido
 * e a sessão atual não verificou o TOTP (`mfaVerifiedAt` nulo), lança
 * `MFA_REQUIRED` — o cliente captura, faz o challenge (verifyMfa) e repete o ato.
 * Permissão fora do conjunto passa direto. Chamar logo após o
 * `requireTenantPermission` correspondente nos handlers protegidos.
 */
export function requireCriticalMfa(
  permission: TenantPermission,
  mfaVerifiedAt: string | null | undefined,
) {
  if (PROTECTED_MFA_PERMISSIONS.has(permission) && !mfaVerifiedAt) {
    throw new Error("MFA_REQUIRED");
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
