import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Gavel, Plus, Flag, ListOrdered, Trophy } from "lucide-react";
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
  getProcurementProcesses,
  openProcurementProcess,
  transitionProcurementProcess,
  recordProcurementProposal,
  getProcurementJudgment,
  adjudicateProcurementWinner,
} from "@/lib/procurement.functions";

export const Route = createFileRoute("/licitacoes")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("contracts.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Process = {
  id: string;
  numero: string;
  ano: number;
  modalidade: string;
  objeto: string;
  valor_estimado: string;
  status: string;
  abertura: string;
  homologado_em: string | null;
  valor_homologado: string | null;
  vencedor: string | null;
};

type Proposal = {
  id: string;
  fornecedor: string;
  fornecedor_documento: string;
  valor_proposto: number;
  desclassificada: boolean;
  motivo_desclassificacao: string | null;
  classificacao: number | null;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);
const modalidades = [
  "pregao",
  "concorrencia",
  "concurso",
  "leilao",
  "dialogo_competitivo",
  "dispensa",
  "inexigibilidade",
  "credenciamento",
] as const;
const desfechos = ["homologada", "fracassada", "deserta", "revogada"] as const;
const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  aberta: "secondary",
  homologada: "default",
  fracassada: "destructive",
  deserta: "outline",
  revogada: "outline",
};

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getProcurementProcesses);
  const openProc = useServerFn(openProcurementProcess);
  const transition = useServerFn(transitionProcurementProcess);
  const propose = useServerFn(recordProcurementProposal);
  const loadJudgment = useServerFn(getProcurementJudgment);
  const adjudicate = useServerFn(adjudicateProcurementWinner);
  const qc = useQueryClient();

  const [openDialog, setOpenDialog] = useState(false);
  const [transOpen, setTransOpen] = useState(false);
  const [target, setTarget] = useState<Process | null>(null);
  const [desfecho, setDesfecho] =
    useState<(typeof desfechos)[number]>("homologada");
  const [busy, setBusy] = useState(false);

  const [judgeOpen, setJudgeOpen] = useState(false);
  const [judgeProc, setJudgeProc] = useState<Process | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [propForm, setPropForm] = useState({
    fornecedor: "",
    fornecedor_documento: "",
    valor_proposto: "",
  });
  const setProp = (k: keyof typeof propForm, v: string) =>
    setPropForm((f) => ({ ...f, [k]: v }));

  const [form, setForm] = useState({
    numero: "",
    ano: String(new Date().getFullYear()),
    modalidade: "pregao" as (typeof modalidades)[number],
    objeto: "",
    valor_estimado: "",
    abertura: hoje(),
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const { data } = useQuery({
    queryKey: ["procurement", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data?.processes ?? []) as Process[];
  const canManage = data?.canManage ?? false;

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["procurement", activeTenant?.id] });

  const submitNew = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await openProc({
        data: {
          tenant_id: activeTenant.id,
          numero: form.numero.trim(),
          ano: Number(form.ano),
          modalidade: form.modalidade,
          objeto: form.objeto.trim(),
          valor_estimado: Number(form.valor_estimado),
          abertura: form.abertura,
        },
      });
      toast.success("Licitação aberta");
      setOpenDialog(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao abrir");
    } finally {
      setBusy(false);
    }
  };

  const openJudgment = async (p: Process) => {
    if (!activeTenant) return;
    setJudgeProc(p);
    setProposals([]);
    setPropForm({
      fornecedor: "",
      fornecedor_documento: "",
      valor_proposto: "",
    });
    setJudgeOpen(true);
    try {
      const r = await loadJudgment({
        data: { tenant_id: activeTenant.id, process_id: p.id },
      });
      setProposals(r.proposals as Proposal[]);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha no julgamento",
      );
    }
  };

  const refreshJudgment = async () => {
    if (!activeTenant || !judgeProc) return;
    const r = await loadJudgment({
      data: { tenant_id: activeTenant.id, process_id: judgeProc.id },
    });
    setProposals(r.proposals as Proposal[]);
  };

  const submitProposal = async () => {
    if (!activeTenant || !judgeProc) return;
    setBusy(true);
    try {
      await propose({
        data: {
          tenant_id: activeTenant.id,
          process_id: judgeProc.id,
          fornecedor: propForm.fornecedor.trim(),
          fornecedor_documento: propForm.fornecedor_documento.trim(),
          valor_proposto: Number(propForm.valor_proposto),
        },
      });
      toast.success("Proposta registrada");
      setPropForm({
        fornecedor: "",
        fornecedor_documento: "",
        valor_proposto: "",
      });
      await refreshJudgment();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha na proposta");
    } finally {
      setBusy(false);
    }
  };

  const doAdjudicate = async (p: Process) => {
    if (!activeTenant) return;
    try {
      const r = await adjudicate({
        data: { tenant_id: activeTenant.id, process_id: p.id },
      });
      toast.success(`Adjudicado — ${brl(r.valor_homologado)}`);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao adjudicar",
      );
    }
  };

  const openTransition = (p: Process) => {
    setTarget(p);
    setDesfecho("homologada");
    setTransOpen(true);
  };

  const submitTransition = async () => {
    if (!activeTenant || !target) return;
    setBusy(true);
    try {
      await transition({
        data: {
          tenant_id: activeTenant.id,
          process_id: target.id,
          desfecho,
          data_referencia: hoje(),
        },
      });
      toast.success(`Licitação ${desfecho}`);
      setTransOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao encerrar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Gavel className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Licitações
            </h1>
            <p className="text-sm text-muted-foreground">
              Processos licitatórios (Lei 14.133) — abertura e homologação
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setOpenDialog(true)}>
            <Plus className="size-4" /> Nova licitação
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Nº/Ano</th>
              <th className="p-3 font-semibold">Modalidade</th>
              <th className="p-3 font-semibold">Objeto</th>
              <th className="p-3 font-semibold text-right">Estimado</th>
              <th className="p-3 font-semibold">Situação</th>
              <th className="p-3 font-semibold">Ações</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className="border-b last:border-0">
                <td className="p-3 font-medium tabular-nums">
                  {p.numero}/{p.ano}
                </td>
                <td className="p-3 capitalize">
                  {p.modalidade.replace("_", " ")}
                </td>
                <td className="p-3">{p.objeto}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(p.valor_estimado)}
                </td>
                <td className="p-3">
                  <Badge variant={statusVariant[p.status] ?? "secondary"}>
                    {p.status}
                  </Badge>
                  {p.vencedor && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      🏆 {p.vencedor} — {brl(p.valor_homologado ?? 0)}
                    </div>
                  )}
                </td>
                <td className="p-3">
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openJudgment(p)}
                    >
                      <ListOrdered className="size-4" /> Propostas
                    </Button>
                    {canManage && p.status === "aberta" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openTransition(p)}
                      >
                        <Flag className="size-4" /> Encerrar
                      </Button>
                    )}
                    {canManage && p.status === "homologada" && !p.vencedor && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => doAdjudicate(p)}
                      >
                        <Trophy className="size-4" /> Adjudicar
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhuma licitação registrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Nova licitação */}
      <Dialog open={openDialog} onOpenChange={setOpenDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova licitação</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Número</Label>
              <Input
                value={form.numero}
                onChange={(e) => set("numero", e.target.value)}
              />
            </div>
            <div>
              <Label>Ano</Label>
              <Input
                type="number"
                value={form.ano}
                onChange={(e) => set("ano", e.target.value)}
              />
            </div>
            <div className="col-span-2">
              <Label>Objeto</Label>
              <Input
                value={form.objeto}
                onChange={(e) => set("objeto", e.target.value)}
              />
            </div>
            <div>
              <Label>Modalidade</Label>
              <Select
                value={form.modalidade}
                onValueChange={(v) =>
                  set("modalidade", v as (typeof modalidades)[number])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modalidades.map((m) => (
                    <SelectItem key={m} value={m} className="capitalize">
                      {m.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Valor estimado</Label>
              <Input
                type="number"
                step="0.01"
                value={form.valor_estimado}
                onChange={(e) => set("valor_estimado", e.target.value)}
              />
            </div>
            <div>
              <Label>Abertura</Label>
              <Input
                type="date"
                value={form.abertura}
                onChange={(e) => set("abertura", e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitNew} disabled={busy}>
              Abrir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Encerrar */}
      <Dialog open={transOpen} onOpenChange={setTransOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Encerrar licitação {target?.numero}/{target?.ano}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Desfecho</Label>
              <Select
                value={desfecho}
                onValueChange={(v) =>
                  setDesfecho(v as (typeof desfechos)[number])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {desfechos.map((d) => (
                    <SelectItem key={d} value={d} className="capitalize">
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitTransition} disabled={busy}>
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Propostas / julgamento */}
      <Dialog open={judgeOpen} onOpenChange={setJudgeOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Propostas — {judgeProc?.numero}/{judgeProc?.ano} (menor preço)
            </DialogTitle>
          </DialogHeader>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-2 font-semibold">Class.</th>
                  <th className="p-2 font-semibold">Fornecedor</th>
                  <th className="p-2 font-semibold text-right">Valor</th>
                  <th className="p-2 font-semibold">Situação</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="p-2 tabular-nums">
                      {p.classificacao === 1 ? (
                        <Badge>1º</Badge>
                      ) : (
                        (p.classificacao ?? "—")
                      )}
                    </td>
                    <td className="p-2">{p.fornecedor}</td>
                    <td className="p-2 text-right tabular-nums">
                      {brl(p.valor_proposto)}
                    </td>
                    <td className="p-2">
                      {p.desclassificada ? (
                        <Badge variant="destructive">desclassificada</Badge>
                      ) : (
                        <Badge variant="secondary">classificada</Badge>
                      )}
                    </td>
                  </tr>
                ))}
                {proposals.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="p-4 text-center text-muted-foreground"
                    >
                      Sem propostas.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {canManage && judgeProc?.status === "aberta" && (
            <div className="grid grid-cols-2 gap-2 border-t pt-3">
              <div className="col-span-2">
                <Label>Fornecedor</Label>
                <Input
                  value={propForm.fornecedor}
                  onChange={(e) => setProp("fornecedor", e.target.value)}
                />
              </div>
              <div>
                <Label>Documento</Label>
                <Input
                  value={propForm.fornecedor_documento}
                  onChange={(e) =>
                    setProp("fornecedor_documento", e.target.value)
                  }
                />
              </div>
              <div>
                <Label>Valor proposto</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={propForm.valor_proposto}
                  onChange={(e) => setProp("valor_proposto", e.target.value)}
                />
              </div>
              <div className="col-span-2">
                <Button
                  onClick={submitProposal}
                  disabled={
                    busy ||
                    !propForm.fornecedor.trim() ||
                    !propForm.fornecedor_documento.trim() ||
                    !propForm.valor_proposto
                  }
                >
                  <Plus className="size-4" /> Adicionar proposta
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
