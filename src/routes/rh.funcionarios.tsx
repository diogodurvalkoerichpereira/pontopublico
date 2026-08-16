import {
  createFileRoute,
  Outlet,
  useNavigate,
  Link,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Users, ChevronRight, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL, type EmployeeStatus } from "@/lib/employee-types";

export const Route = createFileRoute("/rh/funcionarios")({
  component: Page,
});

function Page() {
  const { session, hasPermission, hasTenantPermission, isAdmin, loading } =
    useAuth();
  const nav = useNavigate();
  const { location } = useRouterState();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (hasTenantPermission("people.read")) nav({ to: "/rh/pessoas" });
    else if (!hasPermission("manage_employees")) {
      toast.error("Sem permissão");
      nav({ to: "/app" });
    }
  }, [session, hasPermission, hasTenantPermission, loading, nav]);
  if (hasTenantPermission("people.read")) return null;
  if (!session || !hasPermission("manage_employees")) return null;
  return location.pathname === "/rh/funcionarios" ? (
    <Content isAdmin={isAdmin} />
  ) : (
    <Outlet />
  );
}

function Content({ isAdmin }: { isAdmin: boolean }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<EmployeeStatus | "todos">("todos");

  const { data: funcionarios } = useQuery({
    queryKey: ["funcionarios", status],
    queryFn: async () => {
      let query = supabase
        .from("profiles")
        .select(
          "id, full_name, email, cargo, setor, operacao, status, matricula",
        )
        .order("full_name", { ascending: true });
      if (status !== "todos") query = query.eq("status", status);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  // Usuário(s) master (papel admin) ficam ocultos da lista de funcionários.
  const { data: adminIds } = useQuery({
    queryKey: ["admin-user-ids"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("user_id, role");
      if (error) throw error;
      return new Set(
        (data ?? [])
          .filter((r) => r.role === "admin")
          .map((r) => r.user_id as string),
      );
    },
  });

  const { data: pendingCounts } = useQuery({
    queryKey: ["funcionarios-pending-docs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_documents")
        .select("user_id, status");
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const d of data) {
        if (d.status === "pendente") map[d.user_id] = (map[d.user_id] ?? 0) + 1;
      }
      return map;
    },
  });

  const filtered = (funcionarios ?? []).filter((f) => {
    if (adminIds?.has(f.id)) return false; // oculta usuário master
    if (!q) return true;
    const t = q.toLowerCase();
    return (
      (f.full_name ?? "").toLowerCase().includes(t) ||
      (f.email ?? "").toLowerCase().includes(t) ||
      (f.matricula ?? "").toLowerCase().includes(t) ||
      (f.cargo ?? "").toLowerCase().includes(t) ||
      (f.setor ?? "").toLowerCase().includes(t)
    );
  });

  return (
    <div className="space-y-6 animate-in-up">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight leading-[1.1]">
            Funcionários
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Gestão completa de pessoas e documentos.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Buscar por nome, e-mail, matrícula..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9 w-72"
            />
          </div>
          {isAdmin && (
            <Link to="/admin/usuarios">
              <button className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90">
                <UserPlus className="size-4" /> Novo
              </button>
            </Link>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        {(["todos", "ativo", "ferias", "afastado", "desligado"] as const).map(
          (s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-2.5 py-1 rounded-md font-semibold capitalize transition-colors ${
                status === s
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {s === "todos" ? "Todos" : STATUS_LABEL[s]}
            </button>
          ),
        )}
      </div>

      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            <Users className="size-10 mx-auto opacity-30 mb-3" />
            Nenhum funcionário encontrado.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((f) => {
              const pending = pendingCounts?.[f.id] ?? 0;
              return (
                <Link
                  key={f.id}
                  to="/rh/funcionarios/$id"
                  params={{ id: f.id }}
                  className="flex items-center gap-4 px-5 md:px-6 py-4 hover:bg-muted/40 transition-colors"
                >
                  <div className="size-10 bg-muted rounded-lg flex items-center justify-center font-bold text-muted-foreground text-xs shrink-0">
                    {(f.full_name || "?")
                      .split(" ")
                      .map((p) => p[0])
                      .slice(0, 2)
                      .join("")}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">
                      {f.full_name || f.email || "(Sem nome)"}
                    </p>
                    <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
                      {f.cargo || "—"} · {f.setor || "—"}
                      {f.operacao ? ` · ${f.operacao}` : ""}
                      {f.matricula ? ` · #${f.matricula}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {pending > 0 && (
                      <Badge
                        variant="outline"
                        className="border-warning text-warning"
                      >
                        {pending} doc{pending > 1 ? "s" : ""} pend.
                      </Badge>
                    )}
                    <Badge variant="secondary" className="capitalize">
                      {STATUS_LABEL[f.status as EmployeeStatus]}
                    </Badge>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
