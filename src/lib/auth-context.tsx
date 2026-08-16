import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  getTenantContext,
  type TenantSummary,
} from "@/lib/organization.functions";
import type { TenantPermission } from "@/lib/tenant-access.server";

type Role = "funcionario" | "rh" | "admin";
export type RhPermission =
  | "manage_employees"
  | "approve_documents"
  | "configure_schedules"
  | "close_payroll";

interface AuthCtx {
  user: User | null;
  session: Session | null;
  role: Role | null;
  roles: Role[];
  permissions: RhPermission[];
  isAdmin: boolean;
  isRh: boolean;
  hasPermission: (p: RhPermission) => boolean;
  tenants: TenantSummary[];
  activeTenant: TenantSummary | null;
  tenantPermissions: TenantPermission[];
  hasTenantPermission: (p: TenantPermission) => boolean;
  setActiveTenant: (tenantId: string) => Promise<void>;
  reloadTenantContext: () => Promise<void>;
  loading: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  user: null,
  session: null,
  role: null,
  roles: [],
  permissions: [],
  isAdmin: false,
  isRh: false,
  hasPermission: () => false,
  loading: true,
  tenants: [],
  activeTenant: null,
  tenantPermissions: [],
  hasTenantPermission: () => false,
  setActiveTenant: async () => {},
  reloadTenantContext: async () => {},
  signOut: async () => {},
});

const ACTIVE_TENANT_KEY = "meuponto.activeTenantId";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<RhPermission[]>([]);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [activeTenant, setActiveTenantState] = useState<TenantSummary | null>(
    null,
  );
  const [tenantPermissions, setTenantPermissions] = useState<
    TenantPermission[]
  >([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [accessLoading, setAccessLoading] = useState(false);
  const [tenantLoading, setTenantLoading] = useState(false);
  const loadTenantContextFn = useServerFn(getTenantContext);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s?.user) {
        setAccessLoading(true);
        setTimeout(() => {
          loadAccess(s.user.id);
          loadTenantContext();
        }, 0);
      } else {
        setRoles([]);
        setPermissions([]);
        setTenants([]);
        setActiveTenantState(null);
        setTenantPermissions([]);
        setAccessLoading(false);
        setTenantLoading(false);
      }
    });
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session?.user) {
        setAccessLoading(true);
        loadAccess(data.session.user.id);
        loadTenantContext();
      }
      setSessionLoading(false);
    });
    return () => sub.subscription.unsubscribe();
    // O listener é registrado uma única vez; os carregadores usam a sessão recebida.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAccess = async (userId: string) => {
    try {
      const [rolesRes, permsRes] = await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", userId),
        supabase
          .from("rh_permissions")
          .select("permission")
          .eq("user_id", userId),
      ]);
      const rs = (rolesRes.data ?? []).map((r) => r.role as Role);
      setRoles(rs.length ? rs : ["funcionario"]);
      setPermissions(
        (permsRes.data ?? []).map((p) => p.permission as RhPermission),
      );
    } finally {
      setAccessLoading(false);
    }
  };

  const loadTenantContext = async (requestedTenantId?: string | null) => {
    setTenantLoading(true);
    try {
      const stored =
        typeof window !== "undefined"
          ? localStorage.getItem(ACTIVE_TENANT_KEY)
          : null;
      const result = await loadTenantContextFn({
        data: { active_tenant_id: requestedTenantId ?? stored ?? null },
      });
      setTenants(result.tenants);
      setActiveTenantState(result.activeTenant);
      setTenantPermissions(result.permissions);
      if (typeof window !== "undefined" && result.activeTenant) {
        localStorage.setItem(ACTIVE_TENANT_KEY, result.activeTenant.id);
      }
    } catch (error) {
      // Permite que o legado continue abrindo antes da aplicação da migração.
      console.error("Falha ao carregar contexto da entidade", error);
      setTenants([]);
      setActiveTenantState(null);
      setTenantPermissions([]);
    } finally {
      setTenantLoading(false);
    }
  };

  const loading =
    sessionLoading || (!!session && (accessLoading || tenantLoading));

  const isAdmin = roles.includes("admin");
  const isRh = isAdmin || roles.includes("rh");
  const role: Role | null = isAdmin
    ? "admin"
    : isRh
      ? "rh"
      : (roles[0] ?? null);

  const hasPermission = (p: RhPermission) => isAdmin || permissions.includes(p);
  const hasTenantPermission = (p: TenantPermission) =>
    isAdmin || tenantPermissions.includes(p);

  const setActiveTenant = async (tenantId: string) => {
    if (!tenants.some((tenant) => tenant.id === tenantId))
      throw new Error("Entidade não autorizada");
    await loadTenantContext(tenantId);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setRoles([]);
    setPermissions([]);
    setTenants([]);
    setActiveTenantState(null);
    setTenantPermissions([]);
    if (typeof window !== "undefined")
      localStorage.removeItem(ACTIVE_TENANT_KEY);
  };

  return (
    <Ctx.Provider
      value={{
        user: session?.user ?? null,
        session,
        role,
        roles,
        permissions,
        isAdmin,
        isRh,
        hasPermission,
        tenants,
        activeTenant,
        tenantPermissions,
        hasTenantPermission,
        setActiveTenant,
        reloadTenantContext: () => loadTenantContext(activeTenant?.id),
        loading,
        signOut,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
