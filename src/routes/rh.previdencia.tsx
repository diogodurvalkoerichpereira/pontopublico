import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Landmark, Plus, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import {
  getPensionWorkspace,
  savePensionRegime,
  setPensionRegimeRubrics,
} from "@/lib/pension-regimes.functions";

export const Route = createFileRoute("/rh/previdencia")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("people.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Regime = {
  id: string;
  code: string;
  name: string;
  regime_type: "rpps" | "rgps";
  status: "ativo" | "inativo";
  description: string | null;
};

const regimeTypeLabel = { rpps: "RPPS", rgps: "RGPS" } as const;

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getPensionWorkspace);
  const save = useServerFn(savePensionRegime);
  const setRubrics = useServerFn(setPensionRegimeRubrics);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Regime | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedRegimeId, setSelectedRegimeId] = useState("");
  const [checkedRubrics, setCheckedRubrics] = useState<Set<string>>(new Set());

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [regimeType, setRegimeType] = useState<"rpps" | "rgps">("rpps");
  const [status, setStatus] = useState<"ativo" | "inativo">("ativo");
  const [description, setDescription] = useState("");

  const { data } = useQuery({
    queryKey: ["pension-workspace", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });

  const rubricsByRegime = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const item of data?.regimeRubrics ?? []) {
      if (!map.has(item.pension_regime_id))
        map.set(item.pension_regime_id, new Set());
      map.get(item.pension_regime_id)!.add(item.rubric_id);
    }
    return map;
  }, [data]);

  useEffect(() => {
    if (!selectedRegimeId && data?.regimes[0])
      setSelectedRegimeId(data.regimes[0].id);
  }, [data, selectedRegimeId]);

  useEffect(() => {
    setCheckedRubrics(new Set(rubricsByRegime.get(selectedRegimeId) ?? []));
  }, [selectedRegimeId, rubricsByRegime]);

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["pension-workspace", activeTenant?.id] });

  const openNew = () => {
    setEdit(null);
    setCode("");
    setName("");
    setRegimeType("rpps");
    setStatus("ativo");
    setDescription("");
    setOpen(true);
  };
  const openEdit = (regime: Regime) => {
    setEdit(regime);
    setCode(regime.code);
    setName(regime.name);
    setRegimeType(regime.regime_type);
    setStatus(regime.status);
    setDescription(regime.description ?? "");
    setOpen(true);
  };

  const submitRegime = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await save({
        data: {
          id: edit?.id,
          tenant_id: activeTenant.id,
          code: code.trim().toUpperCase(),
          name: name.trim(),
          regime_type: regimeType,
          status,
          description: description.trim() || null,
        },
      });
      toast.success(edit ? "Regime atualizado" : "Regime criado");
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const toggleRubric = (rubricId: string) => {
    setCheckedRubrics((prev) => {
      const next = new Set(prev);
      if (next.has(rubricId)) next.delete(rubricId);
      else next.add(rubricId);
      return next;
    });
  };

  const saveRubrics = async () => {
    if (!activeTenant || !selectedRegimeId) return;
    setBusy(true);
    try {
      const result = await setRubrics({
        data: {
          tenant_id: activeTenant.id,
          pension_regime_id: selectedRegimeId,
          rubric_ids: [...checkedRubrics],
        },
      });
      toast.success(`${result.count} rubrica(s) vinculadas ao regime`);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const canManageRegimes = data?.canManageRegimes ?? false;
  const canManageRubrics = data?.canManageRubrics ?? false;
  const selectedRegime = data?.regimes.find((r) => r.id === selectedRegimeId);

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Landmark className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Previdência
            </h1>
            <p className="text-sm text-muted-foreground">
              Regimes previdenciários do ente (RPPS/RGPS) e as rubricas de
              contribuição aplicadas por regime no ciclo.
            </p>
          </div>
        </div>
        {canManageRegimes && (
          <Button onClick={openNew}>
            <Plus className="size-4" /> Novo regime
          </Button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3 text-sm font-bold">Regimes</div>
          <div className="divide-y">
            {(data?.regimes ?? []).map((regime) => (
              <button
                key={regime.id}
                onClick={() => setSelectedRegimeId(regime.id)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/50 ${
                  regime.id === selectedRegimeId ? "bg-muted/60" : ""
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-bold">
                      {regime.code}
                    </span>
                    <Badge variant="secondary">
                      {regimeTypeLabel[regime.regime_type]}
                    </Badge>
                    {regime.status === "inativo" && (
                      <Badge variant="outline">inativo</Badge>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {regime.name}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    {rubricsByRegime.get(regime.id)?.size ?? 0} rubrica(s)
                  </Badge>
                  {canManageRegimes && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        openEdit(regime);
                      }}
                    >
                      Editar
                    </Button>
                  )}
                </div>
              </button>
            ))}
            {!data?.regimes.length && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                Nenhum regime cadastrado.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border bg-card">
          <div className="border-b px-4 py-3 text-sm font-bold">
            Rubricas do regime
            {selectedRegime ? ` · ${selectedRegime.code}` : ""}
          </div>
          {selectedRegime ? (
            <div className="space-y-3 p-4">
              <p className="text-xs text-muted-foreground">
                As rubricas marcadas aplicam-se automaticamente a todo vínculo
                deste regime no cálculo da folha.
              </p>
              <div className="max-h-80 space-y-1 overflow-auto">
                {(data?.rubrics ?? []).map((rubric) => (
                  <label
                    key={rubric.id}
                    className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={checkedRubrics.has(rubric.id)}
                      onCheckedChange={() => toggleRubric(rubric.id)}
                      disabled={!canManageRubrics}
                    />
                    <span className="font-mono text-xs font-bold">
                      {rubric.code}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {rubric.name}
                    </span>
                  </label>
                ))}
                {!data?.rubrics.length && (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    Nenhuma rubrica ativa. Cadastre em Rubricas.
                  </div>
                )}
              </div>
              {canManageRubrics && (
                <Button onClick={saveRubrics} disabled={busy}>
                  <Save className="size-4" /> Salvar rubricas do regime
                </Button>
              )}
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Selecione um regime.
            </div>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{edit ? "Editar regime" : "Novo regime"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Código</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="RPPS"
                />
              </div>
              <div className="space-y-1">
                <Label>Tipo</Label>
                <Select
                  value={regimeType}
                  onValueChange={(v) => setRegimeType(v as "rpps" | "rgps")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rpps">RPPS (estatutários)</SelectItem>
                    <SelectItem value="rgps">RGPS (INSS)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Nome</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Regime Próprio de Previdência Social"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Situação</Label>
                <Select
                  value={status}
                  onValueChange={(v) => setStatus(v as "ativo" | "inativo")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ativo">Ativo</SelectItem>
                    <SelectItem value="inativo">Inativo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Descrição (opcional)</Label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={submitRegime} disabled={busy}>
              {edit ? "Salvar" : "Criar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
