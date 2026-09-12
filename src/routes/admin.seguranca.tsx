import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  KeyRound,
  LockKeyhole,
  Plus,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { useMfaChallenge } from "@/components/mfa/mfa-challenge";
import {
  getSecurityModel,
  saveSecurityAssignment,
  saveSecurityRole,
} from "@/lib/organization.functions";

export const Route = createFileRoute("/admin/seguranca")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("security.read")) {
      toast.error("Sem acesso à administração de segurança");
      nav({ to: "/app" });
    }
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

function Content() {
  const { activeTenant } = useAuth();
  const getModel = useServerFn(getSecurityModel);
  const saveRole = useServerFn(saveSecurityRole);
  const saveAssignment = useServerFn(saveSecurityAssignment);
  const { ensure: ensureMfa, dialog: mfaDialog } = useMfaChallenge();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({
    codigo: "",
    nome: "",
    descricao: "",
    permissionIds: [] as string[],
  });
  const [saving, setSaving] = useState(false);
  const [assignmentForm, setAssignmentForm] = useState<{
    open: boolean;
    id?: string;
    userId: string;
    validFrom: string;
    validTo: string;
    revoked: boolean;
    scopes: Record<string, { selected: boolean; descendants: boolean }>;
  }>({
    open: false,
    userId: "",
    validFrom: new Date().toISOString().slice(0, 10),
    validTo: "",
    revoked: false,
    scopes: {},
  });

  const { data, isLoading } = useQuery({
    queryKey: ["security-model", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => getModel({ data: { tenant_id: activeTenant!.id } }),
  });

  useEffect(() => {
    if (!data?.roles.length || selectedId) return;
    selectRole(data.roles[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedId]);

  const selectedRole =
    data?.roles.find((role) => role.id === selectedId) ?? null;
  const assignmentsByUser = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const assignment of data?.assignments ?? []) {
      if (!assignment.active) continue;
      const roles = map.get(assignment.user_id) ?? new Set<string>();
      roles.add(assignment.role_id);
      map.set(assignment.user_id, roles);
    }
    return map;
  }, [data?.assignments]);

  function selectRole(role: NonNullable<typeof data>["roles"][number]) {
    setSelectedId(role.id);
    setForm({
      codigo: role.codigo,
      nome: role.nome,
      descricao: role.descricao ?? "",
      permissionIds: role.permission_ids ?? [],
    });
  }

  const newRole = () => {
    setSelectedId(null);
    setForm({ codigo: "", nome: "", descricao: "", permissionIds: [] });
  };

  const save = async () => {
    if (!activeTenant) return;
    setSaving(true);
    try {
      const result = await ensureMfa(() =>
        saveRole({
          data: {
            id: selectedId ?? undefined,
            tenant_id: activeTenant.id,
            codigo: form.codigo,
            nome: form.nome,
            descricao: form.descricao || null,
            permission_ids: form.permissionIds,
          },
        }),
      );
      setSelectedId(result.id);
      await queryClient.invalidateQueries({
        queryKey: ["security-model", activeTenant.id],
      });
      toast.success("Papel salvo");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Não foi possível salvar o papel",
      );
    } finally {
      setSaving(false);
    }
  };

  const openAssignment = (userId: string) => {
    if (!selectedId || !data) return;
    const assignment = data.assignments.find(
      (item) =>
        item.user_id === userId && item.role_id === selectedId && item.active,
    );
    const scopes = Object.fromEntries(
      data.units.map((unit) => {
        const current = assignment
          ? data.scopes.find(
              (scope) =>
                scope.user_role_id === assignment.id &&
                scope.unit_id === unit.id,
            )
          : undefined;
        return [
          unit.id,
          {
            selected: Boolean(current),
            descendants: current?.include_descendants ?? true,
          },
        ];
      }),
    );
    setAssignmentForm({
      open: true,
      id: assignment?.id,
      userId,
      validFrom:
        assignment?.valid_from ?? new Date().toISOString().slice(0, 10),
      validTo: assignment?.valid_to ?? "",
      revoked: false,
      scopes,
    });
  };

  const submitAssignment = async () => {
    if (!activeTenant || !selectedId) return;
    try {
      await ensureMfa(() =>
        saveAssignment({
          data: {
            id: assignmentForm.id,
            tenant_id: activeTenant.id,
            user_id: assignmentForm.userId,
            role_id: selectedId,
            valid_from: assignmentForm.validFrom,
            valid_to: assignmentForm.validTo || null,
            revoked: assignmentForm.revoked,
            scopes: Object.entries(assignmentForm.scopes)
              .filter(([, scope]) => scope.selected)
              .map(([unit_id, scope]) => ({
                unit_id,
                include_descendants: scope.descendants,
              })),
          },
        }),
      );
      await queryClient.invalidateQueries({
        queryKey: ["security-model", activeTenant.id],
      });
      setAssignmentForm((current) => ({ ...current, open: false }));
      toast.success(
        assignmentForm.revoked
          ? "Atribuição revogada e preservada no histórico"
          : "Vigência e escopo salvos",
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Não foi possível salvar a atribuição",
      );
    }
  };

  if (!activeTenant)
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-amber-900">
        Aplique a migração da Sprint 1 em homologação para habilitar papéis por
        entidade.
      </div>
    );
  if (isLoading || !data)
    return (
      <div className="py-12 text-center text-muted-foreground">
        Carregando segurança...
      </div>
    );

  return (
    <section className="space-y-6">
      {mfaDialog}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <LockKeyhole className="size-7 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Papéis e acessos
            </h1>
            <p className="text-sm text-muted-foreground">
              {activeTenant.nome} · RBAC por entidade.
            </p>
          </div>
        </div>
        {data.canManage && (
          <Button onClick={newRole}>
            <Plus className="mr-2 size-4" />
            Novo papel
          </Button>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
            <ShieldCheck className="size-4" />
            Papéis
          </h2>
          <div className="space-y-2">
            {data.roles.map((role) => (
              <button
                key={role.id}
                onClick={() => selectRole(role)}
                className={`w-full rounded-lg border px-3 py-3 text-left ${selectedId === role.id ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
              >
                <span className="block text-sm font-semibold">{role.nome}</span>
                <span className="text-[11px] text-muted-foreground">
                  {role.codigo}
                  {role.system_role ? " · sistema" : ""}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl border bg-card p-5 shadow-sm">
            <h2 className="mb-4 flex items-center gap-2 font-bold">
              <KeyRound className="size-4" />
              Definição do papel
            </h2>
            <fieldset
              disabled={!data.canManage || saving}
              className="space-y-4 disabled:opacity-70"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <Field
                  label="Código"
                  value={form.codigo}
                  onChange={(codigo) => setForm({ ...form, codigo })}
                  placeholder="gestor_saude"
                />
                <Field
                  label="Nome"
                  value={form.nome}
                  onChange={(nome) => setForm({ ...form, nome })}
                  placeholder="Gestor da Saúde"
                />
              </div>
              <Field
                label="Descrição"
                value={form.descricao}
                onChange={(descricao) => setForm({ ...form, descricao })}
              />
              <div>
                <Label className="mb-2 block">Matriz de permissões</Label>
                <div className="grid gap-2 md:grid-cols-2">
                  {data.permissions.map((permission) => {
                    const checked = form.permissionIds.includes(permission.id);
                    return (
                      <label
                        key={permission.id}
                        className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(value) =>
                            setForm({
                              ...form,
                              permissionIds: value
                                ? [...form.permissionIds, permission.id]
                                : form.permissionIds.filter(
                                    (id) => id !== permission.id,
                                  ),
                            })
                          }
                        />
                        <span>
                          <span className="block font-medium">
                            {permission.nome}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {permission.codigo} · {permission.criticidade}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </fieldset>
            <div className="mt-4 flex justify-end">
              <Button
                onClick={save}
                disabled={
                  !data.canManage || saving || !form.codigo || !form.nome
                }
              >
                <Save className="mr-2 size-4" />
                {saving ? "Salvando..." : "Salvar papel"}
              </Button>
            </div>
          </div>

          {selectedRole && (
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="mb-4 flex items-center gap-2 font-bold">
                <Users className="size-4" />
                Usuários com este papel
              </h2>
              <p className="mb-4 text-sm text-muted-foreground">
                Configure vigência e unidades. Sem unidade selecionada, o escopo
                é global no tenant.
              </p>
              <div className="grid gap-2 md:grid-cols-2">
                {data.users.map((user) => {
                  const assigned =
                    assignmentsByUser.get(user.id)?.has(selectedRole.id) ??
                    false;
                  const historyCount = data.assignments.filter(
                    (assignment) =>
                      assignment.user_id === user.id &&
                      assignment.role_id === selectedRole.id,
                  ).length;
                  return (
                    <div
                      key={user.id}
                      className="flex items-center gap-3 rounded-lg border p-3"
                    >
                      <Checkbox disabled checked={assigned} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">
                          {user.full_name || "Sem nome"}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {user.email}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {assigned ? "vigente" : "sem vigência ativa"} ·{" "}
                          {historyCount} registro(s) no histórico
                        </span>
                      </span>
                      {data.canManage && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openAssignment(user.id)}
                        >
                          <SlidersHorizontal className="mr-1 size-3" />
                          Configurar
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={assignmentForm.open}
        onOpenChange={(open) =>
          setAssignmentForm((current) => ({ ...current, open }))
        }
      >
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Vigência e escopo do papel</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Início</Label>
              <Input
                type="date"
                value={assignmentForm.validFrom}
                onChange={(event) =>
                  setAssignmentForm({
                    ...assignmentForm,
                    validFrom: event.target.value,
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Fim (opcional)</Label>
              <Input
                type="date"
                value={assignmentForm.validTo}
                onChange={(event) =>
                  setAssignmentForm({
                    ...assignmentForm,
                    validTo: event.target.value,
                  })
                }
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Unidades autorizadas</Label>
            {!Object.values(assignmentForm.scopes).some(
              (scope) => scope.selected,
            ) && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                Nenhuma unidade selecionada: esta atribuição terá escopo global
                na entidade.
              </p>
            )}
            <div className="grid gap-2 md:grid-cols-2">
              {data.units.map((unit) => {
                const scope = assignmentForm.scopes[unit.id] ?? {
                  selected: false,
                  descendants: true,
                };
                return (
                  <div key={unit.id} className="rounded-lg border p-3 text-sm">
                    <label className="flex items-center gap-2 font-medium">
                      <Checkbox
                        checked={scope.selected}
                        onCheckedChange={(checked) =>
                          setAssignmentForm({
                            ...assignmentForm,
                            scopes: {
                              ...assignmentForm.scopes,
                              [unit.id]: {
                                ...scope,
                                selected: Boolean(checked),
                              },
                            },
                          })
                        }
                      />
                      {unit.codigo} · {unit.nome}
                    </label>
                    {scope.selected && (
                      <label className="mt-2 flex items-center gap-2 pl-6 text-xs text-muted-foreground">
                        <Checkbox
                          checked={scope.descendants}
                          onCheckedChange={(checked) =>
                            setAssignmentForm({
                              ...assignmentForm,
                              scopes: {
                                ...assignmentForm.scopes,
                                [unit.id]: {
                                  ...scope,
                                  descendants: Boolean(checked),
                                },
                              },
                            })
                          }
                        />
                        Incluir unidades descendentes
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {assignmentForm.id && (
            <label className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <Checkbox
                checked={assignmentForm.revoked}
                onCheckedChange={(checked) =>
                  setAssignmentForm({
                    ...assignmentForm,
                    revoked: Boolean(checked),
                  })
                }
              />
              Revogar agora sem apagar o histórico
            </label>
          )}
          <DialogFooter>
            <Button
              onClick={() => void submitAssignment()}
              disabled={!assignmentForm.validFrom}
            >
              Salvar atribuição
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
