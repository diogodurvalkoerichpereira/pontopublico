import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ShieldAlert, Plus, ClipboardCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import {
  getInternalControlFindings,
  openInternalControlFinding,
  updateInternalControlFinding,
  getInternalControlSummary,
} from "@/lib/internal-control.functions";

export const Route = createFileRoute("/controle-interno")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("analytics.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Finding = {
  id: string;
  ano: number;
  numero: string;
  area: string;
  responsavel: string;
  prazo: string;
  status: string;
  concluido_em: string | null;
};

const hoje = () => new Date().toISOString().slice(0, 10);
const statusLabel: Record<string, string> = {
  aberto: "Aberto",
  em_implementacao: "Em implementação",
  implementado: "Implementado",
  nao_implementado: "Não implementado",
};
const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  aberto: "secondary",
  em_implementacao: "outline",
  implementado: "default",
  nao_implementado: "destructive",
};

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getInternalControlFindings);
  const open = useServerFn(openInternalControlFinding);
  const update = useServerFn(updateInternalControlFinding);
  const loadSummary = useServerFn(getInternalControlSummary);
  const qc = useQueryClient();

  const [openDialog, setOpenDialog] = useState(false);
  const [updOpen, setUpdOpen] = useState(false);
  const [target, setTarget] = useState<Finding | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({
    area: "",
    descricao: "",
    recomendacao: "",
    responsavel: "",
    prazo: "",
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const [novoStatus, setNovoStatus] = useState<
    "em_implementacao" | "implementado" | "nao_implementado"
  >("em_implementacao");
  const [providencia, setProvidencia] = useState("");

  const { data } = useQuery({
    queryKey: ["internal-control", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data?.findings ?? []) as Finding[];
  const canManage = data?.canManage ?? false;

  const { data: summary } = useQuery({
    queryKey: ["internal-control-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadSummary({ data: { tenant_id: activeTenant!.id } }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["internal-control", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["internal-control-summary", activeTenant?.id],
    });
  };

  const submitNew = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await open({
        data: {
          tenant_id: activeTenant.id,
          area: form.area.trim(),
          descricao: form.descricao.trim(),
          recomendacao: form.recomendacao.trim(),
          responsavel: form.responsavel.trim(),
          aberto_em: hoje(),
          prazo: form.prazo,
        },
      });
      toast.success("Apontamento registrado");
      setOpenDialog(false);
      setForm({
        area: "",
        descricao: "",
        recomendacao: "",
        responsavel: "",
        prazo: "",
      });
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao registrar",
      );
    } finally {
      setBusy(false);
    }
  };

  const openUpd = (f: Finding) => {
    setTarget(f);
    setNovoStatus("em_implementacao");
    setProvidencia("");
    setUpdOpen(true);
  };

  const submitUpd = async () => {
    if (!activeTenant || !target) return;
    setBusy(true);
    try {
      await update({
        data: {
          tenant_id: activeTenant.id,
          finding_id: target.id,
          novo_status: novoStatus,
          providencia: providencia.trim(),
          data_referencia: hoje(),
        },
      });
      toast.success("Apontamento atualizado");
      setUpdOpen(false);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao atualizar",
      );
    } finally {
      setBusy(false);
    }
  };

  const encerrado = (s: string) =>
    s === "implementado" || s === "nao_implementado";

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <ShieldAlert className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Controle interno
            </h1>
            <p className="text-sm text-muted-foreground">
              Apontamentos de auditoria (CF art. 74, LRF) e acompanhamento
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setOpenDialog(true)}>
            <Plus className="size-4" /> Novo apontamento
          </Button>
        )}
      </div>

      {summary && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Total</div>
            <div className="text-2xl font-bold">{summary.total}</div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Em curso (aberto + implem.)
            </div>
            <div className="text-2xl font-bold">
              {summary.porStatus.aberto + summary.porStatus.em_implementacao}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Implementados</div>
            <div className="text-2xl font-bold">
              {summary.porStatus.implementado}
            </div>
          </div>
          <div
            className={`rounded-xl border p-4 ${
              summary.vencidos > 0
                ? "border-destructive/50 bg-destructive/5"
                : "bg-card"
            }`}
          >
            <div className="text-sm text-muted-foreground">Prazo vencido</div>
            <div
              className={`text-2xl font-bold ${
                summary.vencidos > 0 ? "text-destructive" : ""
              }`}
            >
              {summary.vencidos}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Nº/Ano</th>
              <th className="p-3 font-semibold">Área</th>
              <th className="p-3 font-semibold">Responsável</th>
              <th className="p-3 font-semibold">Prazo</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.id} className="border-b last:border-0">
                <td className="p-3 font-medium tabular-nums">
                  {f.numero}/{f.ano}
                </td>
                <td className="p-3">{f.area}</td>
                <td className="p-3">{f.responsavel}</td>
                <td className="p-3 tabular-nums">{f.prazo}</td>
                <td className="p-3">
                  <Badge variant={statusVariant[f.status] ?? "secondary"}>
                    {statusLabel[f.status] ?? f.status}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    {!encerrado(f.status) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openUpd(f)}
                      >
                        <ClipboardCheck className="size-4" /> Acompanhar
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 6 : 5}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum apontamento registrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Novo apontamento */}
      <Dialog open={openDialog} onOpenChange={setOpenDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo apontamento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Área</Label>
              <Input
                value={form.area}
                onChange={(e) => set("area", e.target.value)}
              />
            </div>
            <div>
              <Label>Descrição</Label>
              <textarea
                className="w-full rounded-md border bg-background p-2 text-sm"
                rows={3}
                value={form.descricao}
                onChange={(e) => set("descricao", e.target.value)}
              />
            </div>
            <div>
              <Label>Recomendação</Label>
              <textarea
                className="w-full rounded-md border bg-background p-2 text-sm"
                rows={3}
                value={form.recomendacao}
                onChange={(e) => set("recomendacao", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Responsável</Label>
                <Input
                  value={form.responsavel}
                  onChange={(e) => set("responsavel", e.target.value)}
                />
              </div>
              <div>
                <Label>Prazo</Label>
                <Input
                  type="date"
                  value={form.prazo}
                  onChange={(e) => set("prazo", e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitNew} disabled={busy}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Acompanhar */}
      <Dialog open={updOpen} onOpenChange={setUpdOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Acompanhar apontamento {target?.numero}/{target?.ano}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Novo status</Label>
              <Select
                value={novoStatus}
                onValueChange={(v) =>
                  setNovoStatus(
                    v as
                      "em_implementacao" | "implementado" | "nao_implementado",
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="em_implementacao">
                    Em implementação
                  </SelectItem>
                  <SelectItem value="implementado">Implementado</SelectItem>
                  <SelectItem value="nao_implementado">
                    Não implementado
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Providência</Label>
              <textarea
                className="w-full rounded-md border bg-background p-2 text-sm"
                rows={4}
                value={providencia}
                onChange={(e) => setProvidencia(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitUpd} disabled={busy}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
