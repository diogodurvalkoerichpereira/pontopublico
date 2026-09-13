import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  MessageSquareWarning,
  Plus,
  Reply,
  Star,
  Archive,
  Search,
} from "lucide-react";
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
  getManifestations,
  openManifestation,
  respondManifestation,
  getOmbudsmanSummary,
  archiveManifestation,
  analyzeManifestation,
} from "@/lib/ombudsman.functions";
import {
  getOmbudsmanSatisfaction,
  rateManifestation,
} from "@/lib/ombudsman-satisfaction.functions";
import { getResponseTimeliness } from "@/lib/response-timeliness.functions";

export const Route = createFileRoute("/ouvidoria")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("protocol.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Manifestation = {
  id: string;
  ano: number;
  numero: string;
  tipo: string;
  canal: string;
  anonima: boolean;
  status: string;
  prazo_resposta: string;
  respondida_em: string | null;
};

const hoje = () => new Date().toISOString().slice(0, 10);
const tipoLabel: Record<string, string> = {
  denuncia: "Denúncia",
  reclamacao: "Reclamação",
  sugestao: "Sugestão",
  elogio: "Elogio",
  informacao: "Informação",
  solicitacao: "Solicitação",
};
const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  recebida: "secondary",
  em_analise: "outline",
  respondida: "default",
  arquivada: "outline",
};

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getManifestations);
  const open = useServerFn(openManifestation);
  const respond = useServerFn(respondManifestation);
  const loadSatisfaction = useServerFn(getOmbudsmanSatisfaction);
  const rate = useServerFn(rateManifestation);
  const archive = useServerFn(archiveManifestation);
  const analyze = useServerFn(analyzeManifestation);
  const qc = useQueryClient();

  const [openDialog, setOpenDialog] = useState(false);
  const [respondOpen, setRespondOpen] = useState(false);
  const [target, setTarget] = useState<Manifestation | null>(null);
  const [busy, setBusy] = useState(false);

  const [rateTarget, setRateTarget] = useState<Manifestation | null>(null);
  const [nota, setNota] = useState("5");

  const [tipo, setTipo] = useState("reclamacao");
  const [canal, setCanal] = useState("web");
  const [anonima, setAnonima] = useState(false);
  const [descricao, setDescricao] = useState("");

  const [resposta, setResposta] = useState("");

  const { data } = useQuery({
    queryKey: ["ombudsman", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data?.manifestations ?? []) as Manifestation[];
  const canManage = data?.canManage ?? false;

  const { data: satisfaction } = useQuery({
    queryKey: ["ombudsman-satisfaction", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadSatisfaction({ data: { tenant_id: activeTenant!.id } }),
  });
  const loadTimeliness = useServerFn(getResponseTimeliness);
  const { data: timeliness } = useQuery({
    queryKey: ["response-timeliness", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadTimeliness({ data: { tenant_id: activeTenant!.id } }),
  });
  const loadSummary = useServerFn(getOmbudsmanSummary);
  const { data: summary } = useQuery({
    queryKey: ["ombudsman-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadSummary({ data: { tenant_id: activeTenant!.id } }),
  });
  const TIPO_LABEL: Record<string, string> = {
    denuncia: "Denúncia",
    reclamacao: "Reclamação",
    sugestao: "Sugestão",
    elogio: "Elogio",
    informacao: "Informação",
    solicitacao: "Solicitação",
  };

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ombudsman", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["ombudsman-satisfaction", activeTenant?.id],
    });
    qc.invalidateQueries({
      queryKey: ["ombudsman-summary", activeTenant?.id],
    });
    qc.invalidateQueries({
      queryKey: ["response-timeliness", activeTenant?.id],
    });
  };

  const doArchive = async (m: Manifestation) => {
    if (!activeTenant) return;
    if (!window.confirm("Arquivar a manifestação? Encerra o atendimento."))
      return;
    try {
      await archive({
        data: { tenant_id: activeTenant.id, manifestation_id: m.id },
      });
      toast.success("Manifestação arquivada");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao arquivar");
    }
  };

  const doAnalyze = async (m: Manifestation) => {
    if (!activeTenant) return;
    try {
      await analyze({
        data: { tenant_id: activeTenant.id, manifestation_id: m.id },
      });
      toast.success("Manifestação em análise");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao tomar em análise",
      );
    }
  };

  const submitRate = async () => {
    if (!activeTenant || !rateTarget) return;
    setBusy(true);
    try {
      await rate({
        data: {
          tenant_id: activeTenant.id,
          manifestation_id: rateTarget.id,
          nota: Number(nota),
          avaliado_em: new Date().toISOString().slice(0, 10),
        },
      });
      toast.success("Avaliação registrada");
      setRateTarget(null);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao avaliar");
    } finally {
      setBusy(false);
    }
  };

  const openNew = () => {
    setTipo("reclamacao");
    setCanal("web");
    setAnonima(false);
    setDescricao("");
    setOpenDialog(true);
  };

  const submitNew = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await open({
        data: {
          tenant_id: activeTenant.id,
          tipo: tipo as
            | "denuncia"
            | "reclamacao"
            | "sugestao"
            | "elogio"
            | "informacao"
            | "solicitacao",
          canal: canal as "web" | "presencial" | "telefone" | "email" | "carta",
          anonima,
          descricao: descricao.trim(),
          aberta_em: hoje(),
        },
      });
      toast.success("Manifestação registrada");
      setOpenDialog(false);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao registrar",
      );
    } finally {
      setBusy(false);
    }
  };

  const openRespond = (m: Manifestation) => {
    setTarget(m);
    setResposta("");
    setRespondOpen(true);
  };

  const submitRespond = async () => {
    if (!activeTenant || !target) return;
    setBusy(true);
    try {
      await respond({
        data: {
          tenant_id: activeTenant.id,
          manifestation_id: target.id,
          resposta: resposta.trim(),
          respondida_em: hoje(),
        },
      });
      toast.success("Manifestação respondida");
      setRespondOpen(false);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao responder",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <MessageSquareWarning className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Ouvidoria
            </h1>
            <p className="text-sm text-muted-foreground">
              Manifestações do cidadão (Lei 13.460): denúncia, reclamação,
              sugestão, elogio
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={openNew}>
            <Plus className="size-4" /> Nova manifestação
          </Button>
        )}
      </div>

      {summary && (
        <div className="space-y-3">
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            {Object.entries(summary.porTipo).map(([tipo, qtd]) => (
              <div key={tipo} className="rounded-xl border bg-card p-3">
                <div className="text-xs text-muted-foreground">
                  {TIPO_LABEL[tipo] ?? tipo}
                </div>
                <div className="text-xl font-bold">{qtd}</div>
              </div>
            ))}
          </div>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
            <div className="rounded-xl border bg-card p-4">
              <div className="text-sm text-muted-foreground">Em aberto</div>
              <div className="text-2xl font-bold">{summary.emAberto}</div>
            </div>
            <div
              className={`rounded-xl border p-4 ${
                summary.vencidas > 0
                  ? "border-destructive/50 bg-destructive/5"
                  : "bg-card"
              }`}
            >
              <div className="text-sm text-muted-foreground">Vencidas</div>
              <div
                className={`text-2xl font-bold ${
                  summary.vencidas > 0 ? "text-destructive" : ""
                }`}
              >
                {summary.vencidas}
              </div>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <div className="text-sm text-muted-foreground">
                Respondidas no prazo
              </div>
              <div className="text-2xl font-bold">
                {summary.respondidasNoPrazo}
                <span className="text-sm font-normal text-muted-foreground">
                  {" "}
                  / {summary.respondidasNoPrazo + summary.respondidasForaPrazo}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
        <Star className="size-5 text-amber-500" />
        <div>
          <div className="text-sm text-muted-foreground">
            Satisfação do cidadão (Lei 13.460)
          </div>
          <div className="text-xl font-bold">
            {(satisfaction?.media ?? 0).toFixed(2)} / 5,00
            <span className="text-sm font-normal text-muted-foreground">
              {" "}
              — {satisfaction?.total ?? 0} avaliações
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">
            Ouvidoria — respostas no prazo (Lei 13.460)
          </div>
          <div className="text-xl font-bold">
            {(timeliness?.ouvidoria.percentual ?? 0).toFixed(2)}%
            <span className="text-sm font-normal text-muted-foreground">
              {" "}
              — {timeliness?.ouvidoria.no_prazo ?? 0}/
              {timeliness?.ouvidoria.respondidas ?? 0}
            </span>
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">
            e-SIC — respostas no prazo (LAI)
          </div>
          <div className="text-xl font-bold">
            {(timeliness?.esic.percentual ?? 0).toFixed(2)}%
            <span className="text-sm font-normal text-muted-foreground">
              {" "}
              — {timeliness?.esic.no_prazo ?? 0}/
              {timeliness?.esic.respondidas ?? 0}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Nº/Ano</th>
              <th className="p-3 font-semibold">Tipo</th>
              <th className="p-3 font-semibold">Canal</th>
              <th className="p-3 font-semibold">Prazo</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id} className="border-b last:border-0">
                <td className="p-3 font-medium tabular-nums">
                  {m.numero}/{m.ano}
                </td>
                <td className="p-3">
                  {tipoLabel[m.tipo] ?? m.tipo}
                  {m.anonima && (
                    <Badge variant="outline" className="ml-2">
                      anônima
                    </Badge>
                  )}
                </td>
                <td className="p-3 capitalize">{m.canal}</td>
                <td className="p-3 tabular-nums">{m.prazo_resposta}</td>
                <td className="p-3">
                  <Badge variant={statusVariant[m.status] ?? "secondary"}>
                    {m.status.replace("_", " ")}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    {(m.status === "recebida" || m.status === "em_analise") && (
                      <div className="flex gap-2 flex-wrap">
                        {m.status === "recebida" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => doAnalyze(m)}
                          >
                            <Search className="size-4" /> Tomar em análise
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openRespond(m)}
                        >
                          <Reply className="size-4" /> Responder
                        </Button>
                      </div>
                    )}
                    {m.status === "respondida" && (
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRateTarget(m);
                            setNota("5");
                          }}
                        >
                          <Star className="size-4" /> Avaliar
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doArchive(m)}
                        >
                          <Archive className="size-4" /> Arquivar
                        </Button>
                      </div>
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
                  Nenhuma manifestação registrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Nova manifestação */}
      <Dialog open={openDialog} onOpenChange={setOpenDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova manifestação</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Tipo</Label>
              <Select value={tipo} onValueChange={setTipo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(tipoLabel).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Canal</Label>
              <Select value={canal} onValueChange={setCanal}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="web">Web</SelectItem>
                  <SelectItem value="presencial">Presencial</SelectItem>
                  <SelectItem value="telefone">Telefone</SelectItem>
                  <SelectItem value="email">E-mail</SelectItem>
                  <SelectItem value="carta">Carta</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={anonima}
                onCheckedChange={(v) => setAnonima(Boolean(v))}
              />
              Manifestação anônima
            </label>
            <div>
              <Label>Descrição</Label>
              <textarea
                className="w-full rounded-md border bg-background p-2 text-sm"
                rows={4}
                value={descricao}
                onChange={(e) => setDescricao(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitNew} disabled={busy}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Responder */}
      <Dialog open={respondOpen} onOpenChange={setRespondOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Responder manifestação {target?.numero}/{target?.ano}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Resposta</Label>
              <textarea
                className="w-full rounded-md border bg-background p-2 text-sm"
                rows={5}
                value={resposta}
                onChange={(e) => setResposta(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitRespond} disabled={busy}>
              Enviar resposta
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Avaliar (Lei 13.460 art. 23) */}
      <Dialog
        open={Boolean(rateTarget)}
        onOpenChange={(o) => !o && setRateTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Avaliar atendimento — {rateTarget?.numero}/{rateTarget?.ano}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nota (1 a 5)</Label>
              <Select value={nota} onValueChange={setNota}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["1", "2", "3", "4", "5"].map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitRate} disabled={busy}>
              Registrar avaliação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
