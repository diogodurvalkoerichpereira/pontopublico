import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileSearch, Plus, Reply, CalendarPlus, Scale } from "lucide-react";
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
  getEsicRequests,
  openEsicRequest,
  extendEsicRequest,
  respondEsicRequest,
} from "@/lib/esic.functions";
import {
  fileEsicAppeal,
  getEsicAppeals,
  decideEsicAppeal,
} from "@/lib/esic-appeals.functions";

export const Route = createFileRoute("/esic")({ component: Page });

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

type EsicRequest = {
  id: string;
  ano: number;
  numero: string;
  solicitante: string;
  anonimo: boolean;
  status: string;
  prazo_resposta: string;
  prorrogado: boolean;
  respondido_em: string | null;
};

const hoje = () => new Date().toISOString().slice(0, 10);
const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  recebido: "secondary",
  prorrogado: "outline",
  respondido: "default",
  indeferido: "destructive",
};

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getEsicRequests);
  const open = useServerFn(openEsicRequest);
  const extend = useServerFn(extendEsicRequest);
  const respond = useServerFn(respondEsicRequest);
  const appeal = useServerFn(fileEsicAppeal);
  const loadAppeals = useServerFn(getEsicAppeals);
  const decideAppeal = useServerFn(decideEsicAppeal);
  const qc = useQueryClient();

  const [openDialog, setOpenDialog] = useState(false);
  const [respondOpen, setRespondOpen] = useState(false);
  const [target, setTarget] = useState<EsicRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const [appealTarget, setAppealTarget] = useState<EsicRequest | null>(null);
  const [appealFundamento, setAppealFundamento] = useState("");

  const [solicitante, setSolicitante] = useState("");
  const [anonimo, setAnonimo] = useState(false);
  const [pedido, setPedido] = useState("");

  const [desfecho, setDesfecho] = useState<"respondido" | "indeferido">(
    "respondido",
  );
  const [resposta, setResposta] = useState("");

  const { data } = useQuery({
    queryKey: ["esic", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data?.requests ?? []) as EsicRequest[];
  const canManage = data?.canManage ?? false;

  const { data: appealsData } = useQuery({
    queryKey: ["esic-appeals", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadAppeals({ data: { tenant_id: activeTenant!.id } }),
  });
  const appeals = (appealsData?.appeals ?? []) as Array<{
    id: string;
    request_id: string;
    instancia: number;
    status: string;
    decisao: string | null;
  }>;
  const numeroDoPedido = (requestId: string) => {
    const r = items.find((i) => i.id === requestId);
    return r ? `${r.numero}/${r.ano}` : "—";
  };

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["esic", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["esic-appeals", activeTenant?.id] });
  };

  const doDecide = async (
    appealId: string,
    decisao: "provido" | "improvido",
  ) => {
    if (!activeTenant) return;
    try {
      await decideAppeal({
        data: {
          tenant_id: activeTenant.id,
          appeal_id: appealId,
          decisao,
          justificativa: "Análise do recurso pela autoridade superior",
          data_decisao: hoje(),
        },
      });
      toast.success(`Recurso ${decisao}`);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao decidir");
    }
  };

  const doSecondInstance = async (requestId: string) => {
    if (!activeTenant) return;
    try {
      await appeal({
        data: {
          tenant_id: activeTenant.id,
          request_id: requestId,
          instancia: 2,
          fundamento: "Recurso de 2ª instância (LAI art. 16)",
          data_recurso: hoje(),
        },
      });
      toast.success("Recurso de 2ª instância interposto");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha no recurso");
    }
  };

  const submitNew = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await open({
        data: {
          tenant_id: activeTenant.id,
          solicitante: solicitante.trim(),
          anonimo,
          pedido: pedido.trim(),
          aberto_em: hoje(),
        },
      });
      toast.success("Pedido registrado");
      setOpenDialog(false);
      setSolicitante("");
      setPedido("");
      setAnonimo(false);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao registrar",
      );
    } finally {
      setBusy(false);
    }
  };

  const doExtend = async (r: EsicRequest) => {
    if (!activeTenant) return;
    try {
      await extend({
        data: { tenant_id: activeTenant.id, request_id: r.id },
      });
      toast.success("Prazo prorrogado (+10 dias)");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao prorrogar",
      );
    }
  };

  const openRespond = (r: EsicRequest) => {
    setTarget(r);
    setDesfecho("respondido");
    setResposta("");
    setRespondOpen(true);
  };

  const submitAppeal = async () => {
    if (!activeTenant || !appealTarget) return;
    setBusy(true);
    try {
      await appeal({
        data: {
          tenant_id: activeTenant.id,
          request_id: appealTarget.id,
          instancia: 1,
          fundamento: appealFundamento.trim(),
          data_recurso: hoje(),
        },
      });
      toast.success("Recurso interposto (1ª instância)");
      setAppealTarget(null);
      setAppealFundamento("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha no recurso");
    } finally {
      setBusy(false);
    }
  };

  const submitRespond = async () => {
    if (!activeTenant || !target) return;
    setBusy(true);
    try {
      await respond({
        data: {
          tenant_id: activeTenant.id,
          request_id: target.id,
          desfecho,
          resposta: resposta.trim(),
          respondido_em: hoje(),
        },
      });
      toast.success(desfecho === "respondido" ? "Respondido" : "Indeferido");
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

  const emAberto = (s: string) => s === "recebido" || s === "prorrogado";

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <FileSearch className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">e-SIC</h1>
            <p className="text-sm text-muted-foreground">
              Acesso à informação (LAI) — prazo de 20 dias, prorrogável por +10
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setOpenDialog(true)}>
            <Plus className="size-4" /> Novo pedido
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Nº/Ano</th>
              <th className="p-3 font-semibold">Solicitante</th>
              <th className="p-3 font-semibold">Prazo</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="p-3 font-medium tabular-nums">
                  {r.numero}/{r.ano}
                </td>
                <td className="p-3">
                  {r.anonimo ? (
                    <Badge variant="outline">anônimo</Badge>
                  ) : (
                    r.solicitante
                  )}
                </td>
                <td className="p-3 tabular-nums">{r.prazo_resposta}</td>
                <td className="p-3">
                  <Badge variant={statusVariant[r.status] ?? "secondary"}>
                    {r.status}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    {emAberto(r.status) && (
                      <div className="flex gap-2">
                        {r.status === "recebido" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => doExtend(r)}
                          >
                            <CalendarPlus className="size-4" /> Prorrogar
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openRespond(r)}
                        >
                          <Reply className="size-4" /> Responder
                        </Button>
                      </div>
                    )}
                    {r.status === "indeferido" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setAppealTarget(r);
                          setAppealFundamento("");
                        }}
                      >
                        <Scale className="size-4" /> Recorrer
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 5 : 4}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum pedido registrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {appeals.length > 0 && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <h2 className="font-bold p-3">Recursos (LAI art. 15-16)</h2>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Pedido</th>
                <th className="p-3 font-semibold">Instância</th>
                <th className="p-3 font-semibold">Situação</th>
                <th className="p-3 font-semibold">Decisão</th>
                {canManage && <th className="p-3 font-semibold">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {appeals.map((a) => {
                const temSegunda = appeals.some(
                  (x) => x.request_id === a.request_id && x.instancia === 2,
                );
                return (
                  <tr key={a.id} className="border-b last:border-0">
                    <td className="p-3 tabular-nums">
                      {numeroDoPedido(a.request_id)}
                    </td>
                    <td className="p-3">{a.instancia}ª</td>
                    <td className="p-3">
                      <Badge
                        variant={
                          a.status === "provido"
                            ? "default"
                            : a.status === "improvido"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {a.status}
                      </Badge>
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {a.decisao ?? "—"}
                    </td>
                    {canManage && (
                      <td className="p-3">
                        <div className="flex gap-2 flex-wrap">
                          {a.status === "pendente" && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => doDecide(a.id, "provido")}
                              >
                                Prover
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => doDecide(a.id, "improvido")}
                              >
                                Improver
                              </Button>
                            </>
                          )}
                          {a.instancia === 1 &&
                            a.status === "improvido" &&
                            !temSegunda && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => doSecondInstance(a.request_id)}
                              >
                                2ª instância
                              </Button>
                            )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Novo pedido */}
      <Dialog open={openDialog} onOpenChange={setOpenDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo pedido de informação</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Solicitante</Label>
              <Input
                value={solicitante}
                onChange={(e) => setSolicitante(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={anonimo}
                onCheckedChange={(v) => setAnonimo(Boolean(v))}
              />
              Pedido anônimo
            </label>
            <div>
              <Label>Pedido</Label>
              <textarea
                className="w-full rounded-md border bg-background p-2 text-sm"
                rows={4}
                value={pedido}
                onChange={(e) => setPedido(e.target.value)}
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
              Responder pedido {target?.numero}/{target?.ano}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Desfecho</Label>
              <Select
                value={desfecho}
                onValueChange={(v) =>
                  setDesfecho(v as "respondido" | "indeferido")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="respondido">Respondido</SelectItem>
                  <SelectItem value="indeferido">Indeferido</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
              Enviar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recurso (LAI art. 15) */}
      <Dialog
        open={Boolean(appealTarget)}
        onOpenChange={(o) => !o && setAppealTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Recurso — pedido {appealTarget?.numero}/{appealTarget?.ano}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Recurso de 1ª instância contra a negativa de acesso (LAI art. 15).
            </p>
            <div>
              <Label>Fundamento</Label>
              <Input
                value={appealFundamento}
                onChange={(e) => setAppealFundamento(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitAppeal}
              disabled={busy || appealFundamento.trim().length < 3}
            >
              Interpor recurso
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
