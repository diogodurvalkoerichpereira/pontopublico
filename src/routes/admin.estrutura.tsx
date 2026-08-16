import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Building2,
  ChevronRight,
  CirclePlus,
  Network,
  Pencil,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
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
import {
  createTenant,
  getOrganizationTree,
  saveOrganizationUnit,
  type OrganizationUnit,
} from "@/lib/organization.functions";

export const Route = createFileRoute("/admin/estrutura")({ component: Page });

type UnitType = OrganizationUnit["tipo"];
type UnitForm = {
  id?: string;
  parent_id: string;
  codigo: string;
  nome: string;
  tipo: UnitType;
  ativo: boolean;
  ordem: number;
  cnpj: string;
};

const emptyForm = (): UnitForm => ({
  parent_id: "",
  codigo: "",
  nome: "",
  tipo: "unidade",
  ativo: true,
  ordem: 0,
  cnpj: "",
});

function Page() {
  const { session, loading, activeTenant, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("org.read")) {
      toast.error("Sem acesso à estrutura organizacional");
      nav({ to: "/app" });
    }
  }, [session, loading, activeTenant, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

function Content() {
  const { activeTenant, hasTenantPermission, isAdmin, reloadTenantContext } =
    useAuth();
  const getTree = useServerFn(getOrganizationTree);
  const saveUnit = useServerFn(saveOrganizationUnit);
  const addTenant = useServerFn(createTenant);
  const queryClient = useQueryClient();
  const canManage = hasTenantPermission("org.manage");
  const [form, setForm] = useState<UnitForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [tenantDialog, setTenantDialog] = useState(false);
  const [tenantForm, setTenantForm] = useState({
    codigo: "",
    nome: "",
    cnpj: "",
  });

  const { data: units = [], isLoading } = useQuery({
    queryKey: ["organization-tree", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => getTree({ data: { tenant_id: activeTenant!.id } }),
  });

  const flatTree = useMemo(() => flattenTree(units), [units]);

  const edit = (unit: OrganizationUnit) =>
    setForm({
      id: unit.id,
      parent_id: unit.parent_id ?? "",
      codigo: unit.codigo,
      nome: unit.nome,
      tipo: unit.tipo,
      ativo: unit.ativo,
      ordem: unit.ordem,
      cnpj: unit.cnpj ?? "",
    });

  const submit = async () => {
    if (!activeTenant) return;
    setSaving(true);
    try {
      await saveUnit({
        data: {
          ...form,
          tenant_id: activeTenant.id,
          parent_id: form.parent_id || null,
          cnpj: form.cnpj || null,
        },
      });
      toast.success(form.id ? "Unidade atualizada" : "Unidade criada");
      setForm(emptyForm());
      await queryClient.invalidateQueries({
        queryKey: ["organization-tree", activeTenant.id],
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Não foi possível salvar",
      );
    } finally {
      setSaving(false);
    }
  };

  const submitTenant = async () => {
    try {
      await addTenant({
        data: {
          ...tenantForm,
          cnpj: tenantForm.cnpj || null,
          timezone: "America/Sao_Paulo",
        },
      });
      await reloadTenantContext();
      setTenantDialog(false);
      setTenantForm({ codigo: "", nome: "", cnpj: "" });
      toast.success(
        "Entidade criada. Selecione-a no cabeçalho para configurar a estrutura.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Não foi possível criar a entidade",
      );
    }
  };

  if (!activeTenant) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-amber-900">
        A migração da Sprint 1 precisa ser aplicada em homologação para
        habilitar o contexto de entidade.
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Network className="size-7 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Estrutura organizacional
            </h1>
            <p className="text-sm text-muted-foreground">
              {activeTenant.nome} · árvore sem exclusão do histórico.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <Button variant="outline" onClick={() => setTenantDialog(true)}>
              <Building2 className="mr-2 size-4" />
              Nova entidade
            </Button>
          )}
          {canManage && (
            <Button onClick={() => setForm(emptyForm())}>
              <CirclePlus className="mr-2 size-4" />
              Nova unidade
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(320px,0.9fr)_minmax(460px,1.35fr)]">
        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-muted-foreground">
            Árvore
          </h2>
          {isLoading && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Carregando...
            </p>
          )}
          {!isLoading && !flatTree.length && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nenhuma unidade cadastrada.
            </p>
          )}
          <div className="space-y-1">
            {flatTree.map(({ unit, depth }) => (
              <button
                key={unit.id}
                onClick={() => edit(unit)}
                className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted ${form.id === unit.id ? "border-primary bg-primary/5" : "border-transparent"}`}
                style={{ paddingLeft: 12 + depth * 22 }}
              >
                {depth > 0 && (
                  <ChevronRight className="size-3 text-muted-foreground" />
                )}
                <Building2 className="size-4 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {unit.nome}
                  </span>
                  <span className="block text-[11px] uppercase text-muted-foreground">
                    {unit.codigo} · {unit.tipo.replace("_", " ")}
                  </span>
                </span>
                {!unit.ativo && (
                  <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px]">
                    Inativa
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="font-bold">
                {form.id ? "Editar unidade" : "Cadastrar unidade"}
              </h2>
              <p className="text-xs text-muted-foreground">
                Código único dentro da entidade; a unidade-pai deve pertencer à
                mesma árvore.
              </p>
            </div>
            {form.id && <Pencil className="size-5 text-muted-foreground" />}
          </div>
          <fieldset
            disabled={!canManage || saving}
            className="grid gap-4 md:grid-cols-2 disabled:opacity-70"
          >
            <Field
              label="Código"
              value={form.codigo}
              onChange={(codigo) => setForm({ ...form, codigo })}
              placeholder="SMS"
            />
            <Field
              label="Nome"
              value={form.nome}
              onChange={(nome) => setForm({ ...form, nome })}
              placeholder="Secretaria Municipal de Saúde"
            />
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.tipo}
                onChange={(event) =>
                  setForm({ ...form, tipo: event.target.value as UnitType })
                }
              >
                <option value="entidade">Entidade</option>
                <option value="secretaria">Secretaria</option>
                <option value="departamento">Departamento</option>
                <option value="unidade">Unidade</option>
                <option value="setor">Setor</option>
                <option value="centro_custo">Centro de custo</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Unidade-pai</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={form.parent_id}
                onChange={(event) =>
                  setForm({ ...form, parent_id: event.target.value })
                }
              >
                <option value="">Raiz da entidade</option>
                {flatTree
                  .filter(({ unit }) => unit.id !== form.id)
                  .map(({ unit, depth }) => (
                    <option key={unit.id} value={unit.id}>
                      {"— ".repeat(depth)}
                      {unit.nome}
                    </option>
                  ))}
              </select>
            </div>
            <Field
              label="CNPJ (opcional)"
              value={form.cnpj}
              onChange={(cnpj) => setForm({ ...form, cnpj })}
            />
            <Field
              label="Ordem"
              type="number"
              value={String(form.ordem)}
              onChange={(ordem) =>
                setForm({ ...form, ordem: Number(ordem) || 0 })
              }
            />
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={form.ativo}
                onChange={(event) =>
                  setForm({ ...form, ativo: event.target.checked })
                }
              />
              Unidade ativa
            </label>
          </fieldset>
          <div className="mt-5 flex justify-end">
            <Button
              onClick={submit}
              disabled={!canManage || saving || !form.codigo || !form.nome}
            >
              <Save className="mr-2 size-4" />
              {saving ? "Salvando..." : "Salvar"}
            </Button>
          </div>
          {!canManage && (
            <p className="mt-3 text-xs text-amber-700">
              Seu papel permite consultar, mas não alterar a estrutura.
            </p>
          )}
        </div>
      </div>

      <Dialog open={tenantDialog} onOpenChange={setTenantDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova entidade</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <Field
              label="Código"
              value={tenantForm.codigo}
              onChange={(codigo) => setTenantForm({ ...tenantForm, codigo })}
              placeholder="PREF-SJ"
            />
            <Field
              label="Nome"
              value={tenantForm.nome}
              onChange={(nome) => setTenantForm({ ...tenantForm, nome })}
              placeholder="Prefeitura Municipal"
            />
            <Field
              label="CNPJ (opcional)"
              value={tenantForm.cnpj}
              onChange={(cnpj) => setTenantForm({ ...tenantForm, cnpj })}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTenantDialog(false)}>
              Cancelar
            </Button>
            <Button onClick={submitTenant}>Criar entidade</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function flattenTree(units: OrganizationUnit[]) {
  const byParent = new Map<string | null, OrganizationUnit[]>();
  for (const unit of units) {
    const key = unit.parent_id ?? null;
    const list = byParent.get(key) ?? [];
    list.push(unit);
    byParent.set(key, list);
  }
  const result: { unit: OrganizationUnit; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const unit of byParent.get(parentId) ?? []) {
      if (visited.has(unit.id)) continue;
      visited.add(unit.id);
      result.push({ unit, depth });
      visit(unit.id, depth + 1);
    }
  };
  visit(null, 0);
  for (const unit of units)
    if (!visited.has(unit.id)) result.push({ unit, depth: 0 });
  return result;
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
