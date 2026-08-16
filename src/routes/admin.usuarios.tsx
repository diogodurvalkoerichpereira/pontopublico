import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Shield,
  UserCog,
  UserPlus,
  Trash2,
  KeyRound,
  Pencil,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type RhPermission } from "@/lib/auth-context";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  adminCreateUser,
  adminDeleteUser,
  adminResetPassword,
} from "@/lib/admin-users.functions";
import { getTenantUsers } from "@/lib/organization.functions";

export const Route = createFileRoute("/admin/usuarios")({ component: Page });

const PERMS: { key: RhPermission; label: string }[] = [
  { key: "manage_employees", label: "Gerir funcionários" },
  { key: "approve_documents", label: "Aprovar documentos/atestados" },
  { key: "configure_schedules", label: "Configurar escalas e salários" },
  { key: "close_payroll", label: "Fechar folha do mês" },
];

function Page() {
  const { session, isAdmin, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!isAdmin) {
      toast.error("Apenas administradores");
      nav({ to: "/app" });
    }
  }, [session, isAdmin, loading, nav]);
  if (!session || !isAdmin) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

function Content() {
  const { user, activeTenant } = useAuth();
  const qc = useQueryClient();
  const createUser = useServerFn(adminCreateUser);
  const deleteUser = useServerFn(adminDeleteUser);
  const resetPassword = useServerFn(adminResetPassword);
  const loadTenantUsers = useServerFn(getTenantUsers);
  const [open, setOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [confirmReset, setConfirmReset] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const { data: users } = useQuery({
    queryKey: ["admin-users", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: async () => {
      if (!activeTenant) return [];
      const result = await loadTenantUsers({
        data: { tenant_id: activeTenant.id },
      });
      return result.map((profile) => ({
        ...profile,
        perms: profile.perms as RhPermission[],
      }));
    },
  });

  const onDelete = async () => {
    if (!confirmDel) return;
    try {
      await deleteUser({ data: { user_id: confirmDel.id } });
      toast.success("Usuário excluído");
      setConfirmDel(null);
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao excluir");
    }
  };

  const onResetPassword = async () => {
    if (!confirmReset) return;
    setResetting(true);
    try {
      await resetPassword({
        data: { user_id: confirmReset.id, password: newPassword },
      });
      toast.success(
        `Senha de ${confirmReset.name} redefinida; sessões anteriores revogadas`,
      );
      setNewPassword("");
      setConfirmReset(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao redefinir senha");
    } finally {
      setResetting(false);
    }
  };

  const togglePerm = async (
    userId: string,
    perm: RhPermission,
    on: boolean,
  ) => {
    if (on) {
      const { error } = await supabase
        .from("rh_permissions")
        .insert({ user_id: userId, permission: perm });
      if (error) return toast.error(error.message);
    } else {
      const { error } = await supabase
        .from("rh_permissions")
        .delete()
        .eq("user_id", userId)
        .eq("permission", perm);
      if (error) return toast.error(error.message);
    }
    qc.invalidateQueries({ queryKey: ["admin-users"] });
  };

  const setRole = async (userId: string, role: "rh" | "admin", on: boolean) => {
    if (on) {
      const { error } = await supabase
        .from("user_roles")
        .insert({ user_id: userId, role });
      if (error) return toast.error(error.message);
      // ao virar RH, conceder todas as permissões por padrão
      if (role === "rh") {
        await supabase.from("rh_permissions").upsert(
          PERMS.map((p) => ({ user_id: userId, permission: p.key })),
          { onConflict: "user_id,permission", ignoreDuplicates: true },
        );
      }
      toast.success("Permissão concedida");
    } else {
      const { error } = await supabase
        .from("user_roles")
        .delete()
        .eq("user_id", userId)
        .eq("role", role);
      if (error) return toast.error(error.message);
      toast.success("Permissão removida");
    }
    qc.invalidateQueries({ queryKey: ["admin-users"] });
  };

  // Usuário(s) master (papel admin) ficam ocultos desta lista.
  const visibleUsers = (users ?? []).filter((u) => !u.roles.includes("admin"));

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <UserCog className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Gestão de usuários
            </h1>
            <p className="text-sm text-muted-foreground">
              Crie, defina papéis, permissões e exclua usuários.
            </p>
          </div>
        </div>
        <Button onClick={() => setOpen(true)}>
          <UserPlus className="size-4 mr-2" /> Novo usuário
        </Button>
      </div>

      <div className="space-y-3">
        {visibleUsers.map((u) => {
          const isRh = u.roles.includes("rh") || u.roles.includes("admin");
          const isAdmin = u.roles.includes("admin");
          const isSelf = u.id === user?.id;
          return (
            <div
              key={u.id}
              className="rounded-lg border border-border p-4 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">{u.full_name || "—"}</div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {u.email}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {u.cargo || "—"} · {u.setor || "—"}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isAdmin && (
                    <Badge variant="default" className="gap-1">
                      <Shield className="size-3" />
                      Admin
                    </Badge>
                  )}
                  {isRh && !isAdmin && <Badge variant="secondary">RH</Badge>}
                  {!isRh && <Badge variant="outline">Colaborador</Badge>}
                  <Button
                    size="sm"
                    variant={isRh ? "outline" : "default"}
                    onClick={() => setRole(u.id, "rh", !u.roles.includes("rh"))}
                  >
                    {u.roles.includes("rh") ? "Remover RH" : "Tornar RH"}
                  </Button>
                  <Button
                    size="sm"
                    variant={isAdmin ? "outline" : "secondary"}
                    onClick={() => setRole(u.id, "admin", !isAdmin)}
                  >
                    {isAdmin ? "Remover Admin" : "Tornar Admin"}
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/rh/funcionarios/$id" params={{ id: u.id }}>
                      <Pencil className="size-3.5 mr-1" /> Editar
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setConfirmReset({
                        id: u.id,
                        name: u.full_name || u.email || "",
                      })
                    }
                  >
                    <KeyRound className="size-3.5 mr-1" /> Resetar senha
                  </Button>
                  {!isSelf && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() =>
                        setConfirmDel({
                          id: u.id,
                          name: u.full_name || u.email || "",
                        })
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>

              {isRh && !isAdmin && (
                <div className="border-t border-border pt-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Permissões
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {PERMS.map((p) => {
                      const has = u.perms.includes(p.key);
                      return (
                        <label
                          key={p.key}
                          className="flex items-center gap-2 text-sm cursor-pointer"
                        >
                          <Checkbox
                            checked={has}
                            onCheckedChange={(v) =>
                              togglePerm(u.id, p.key, !!v)
                            }
                          />
                          {p.label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!visibleUsers.length && (
          <div className="text-center text-muted-foreground py-12">
            Nenhum usuário.
          </div>
        )}
      </div>

      <CreateUserDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (form) => {
          try {
            await createUser({
              data: { ...form, tenant_id: activeTenant?.id },
            });
            toast.success("Usuário criado");
            setOpen(false);
            qc.invalidateQueries({ queryKey: ["admin-users"] });
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Erro ao criar");
            throw e;
          }
        }}
      />

      <Dialog
        open={!!confirmReset}
        onOpenChange={(o) => !o && setConfirmReset(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Redefinir senha</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Defina uma senha temporária forte para{" "}
            <strong>{confirmReset?.name}</strong>. Todas as sessões anteriores
            serão revogadas.
          </p>
          <div className="space-y-1">
            <Label>Nova senha temporária</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              minLength={12}
              maxLength={72}
              placeholder="12+ caracteres, Aa, número e símbolo"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmReset(null)}
              disabled={resetting}
            >
              Cancelar
            </Button>
            <Button
              onClick={onResetPassword}
              disabled={resetting || newPassword.length < 12}
            >
              {resetting ? "Redefinindo..." : "Redefinir senha"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!confirmDel}
        onOpenChange={(o) => !o && setConfirmDel(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir usuário</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Tem certeza que deseja excluir <strong>{confirmDel?.name}</strong>?
            Essa ação remove o login e o perfil permanentemente.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(null)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={onDelete}>
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (f: {
    email: string;
    password: string;
    full_name: string;
    cpf: string;
    matricula: string;
    setor: string;
    cargo: string;
    role: "funcionario" | "rh" | "admin";
  }) => Promise<void>;
}) {
  const [f, setF] = useState({
    email: "",
    password: "",
    full_name: "",
    cpf: "",
    matricula: "",
    setor: "",
    cargo: "",
    role: "funcionario" as "funcionario" | "rh" | "admin",
  });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!f.email || !f.password || !f.full_name) {
      toast.error("Preencha nome, e-mail e senha");
      return;
    }
    setBusy(true);
    try {
      await onCreate(f);
      setF({
        email: "",
        password: "",
        full_name: "",
        cpf: "",
        matricula: "",
        setor: "",
        cargo: "",
        role: "funcionario",
      });
    } catch {
      // toast já mostrado
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo usuário</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field
            label="Nome completo *"
            value={f.full_name}
            onChange={(v) => setF({ ...f, full_name: v })}
          />
          <Field
            label="E-mail *"
            type="email"
            value={f.email}
            onChange={(v) => setF({ ...f, email: v })}
          />
          <Field
            label="Senha *"
            type="password"
            value={f.password}
            onChange={(v) => setF({ ...f, password: v })}
          />
          <Field
            label="CPF"
            value={f.cpf}
            onChange={(v) => setF({ ...f, cpf: v })}
          />
          <Field
            label="Matrícula"
            value={f.matricula}
            onChange={(v) => setF({ ...f, matricula: v })}
          />
          <Field
            label="Setor"
            value={f.setor}
            onChange={(v) => setF({ ...f, setor: v })}
          />
          <Field
            label="Cargo"
            value={f.cargo}
            onChange={(v) => setF({ ...f, cargo: v })}
          />
          <div className="space-y-1.5">
            <Label className="text-[11px] font-bold uppercase text-muted-foreground">
              Papel
            </Label>
            <Select
              value={f.role}
              onValueChange={(v) => setF({ ...f, role: v as typeof f.role })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="funcionario">Colaborador</SelectItem>
                <SelectItem value="rh">RH (todas as permissões)</SelectItem>
                <SelectItem value="admin">Administrador</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancelar
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Criando..." : "Criar usuário"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-bold uppercase text-muted-foreground">
        {label}
      </Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
