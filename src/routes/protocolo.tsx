import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileStack, Plus, Send, History, Archive } from "lucide-react";
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
import { useAuth } from "@/lib/auth-context";
import {
  getProtocolProcesses,
  openProtocolProcess,
  recordProtocolMovement,
  getProtocolMovements,
  archiveProtocolProcess,
} from "@/lib/protocol.functions";

export const Route = createFileRoute("/protocolo")({ component: Page });

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

type ProtocolProcess = {
  id: string;
  ano: number;
  numero: string;
  assunto: string;
  interessado: string;
  unidade_atual_id: string | null;
  status: string;
  aberto_em: string;
};

type Movement = {
  id: string;
  unidade_origem: string | null;
  unidade_destino: string | null;
  despacho: string;
  data_movimento: string;
};

const hoje = () => new Date().toISOString().slice(0, 10);
const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  em_tramitacao: "secondary",
  concluido: "default",
  arquivado: "outline",
};

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getProtocolProcesses);
  const openProc = useServerFn(openProtocolProcess);
  const move = useServerFn(recordProtocolMovement);
  const loadMovements = useServerFn(getProtocolMovements);
  const archive = useServerFn(archiveProtocolProcess);
  const qc = useQueryClient();

  const [openDialog, setOpenDialog] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [target, setTarget] = useState<ProtocolProcess | null>(null);
  const [busy, setBusy] = useState(false);

  const [histOpen, setHistOpen] = useState(false);
  const [histProcess, setHistProcess] = useState<ProtocolProcess | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);

  const [assunto, setAssunto] = useState("");
  const [interessado, setInteressado] = useState("");

  const [despacho, setDespacho] = useState("");
  const [concluir, setConcluir] = useState(false);

  const { data } = useQuery({
    queryKey: ["protocol", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data?.processes ?? []) as ProtocolProcess[];
  const canManage = data?.canManage ?? false;

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["protocol", activeTenant?.id] });

  const submitNew = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await openProc({
        data: {
          tenant_id: activeTenant.id,
          assunto: assunto.trim(),
          interessado: interessado.trim(),
          aberto_em: hoje(),
        },
      });
      toast.success("Processo aberto");
      setOpenDialog(false);
      setAssunto("");
      setInteressado("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao abrir");
    } finally {
      setBusy(false);
    }
  };

  const openMove = (p: ProtocolProcess) => {
    setTarget(p);
    setDespacho("");
    setConcluir(false);
    setMoveOpen(true);
  };

  const doArchive = async (p: ProtocolProcess) => {
    if (!activeTenant) return;
    try {
      await archive({
        data: {
          tenant_id: activeTenant.id,
          process_id: p.id,
          motivo: "Encerramento do trâmite",
        },
      });
      toast.success("Processo arquivado");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao arquivar");
    }
  };

  const openHistory = async (p: ProtocolProcess) => {
    if (!activeTenant) return;
    setHistProcess(p);
    setMovements([]);
    setHistOpen(true);
    try {
      const r = await loadMovements({
        data: { tenant_id: activeTenant.id, process_id: p.id },
      });
      setMovements(r.movements as Movement[]);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha no histórico",
      );
    }
  };

  const submitMove = async () => {
    if (!activeTenant || !target) return;
    setBusy(true);
    try {
      await move({
        data: {
          tenant_id: activeTenant.id,
          process_id: target.id,
          despacho: despacho.trim(),
          concluir,
        },
      });
      toast.success(concluir ? "Processo concluído" : "Tramitação registrada");
      setMoveOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao tramitar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <FileStack className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Protocolo
            </h1>
            <p className="text-sm text-muted-foreground">
              Processo eletrônico — numeração por ano, tramitação e despacho
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setOpenDialog(true)}>
            <Plus className="size-4" /> Novo processo
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Nº/Ano</th>
              <th className="p-3 font-semibold">Assunto</th>
              <th className="p-3 font-semibold">Interessado</th>
              <th className="p-3 font-semibold">Aberto em</th>
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
                <td className="p-3">{p.assunto}</td>
                <td className="p-3">{p.interessado}</td>
                <td className="p-3 tabular-nums text-muted-foreground">
                  {p.aberto_em}
                </td>
                <td className="p-3">
                  <Badge variant={statusVariant[p.status] ?? "secondary"}>
                    {p.status.replace("_", " ")}
                  </Badge>
                </td>
                <td className="p-3">
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openHistory(p)}
                    >
                      <History className="size-4" /> Histórico
                    </Button>
                    {canManage && p.status === "em_tramitacao" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openMove(p)}
                      >
                        <Send className="size-4" /> Tramitar
                      </Button>
                    )}
                    {canManage && p.status === "concluido" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => doArchive(p)}
                      >
                        <Archive className="size-4" /> Arquivar
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
                  Nenhum processo aberto.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Novo processo */}
      <Dialog open={openDialog} onOpenChange={setOpenDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo processo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Assunto</Label>
              <Input
                value={assunto}
                onChange={(e) => setAssunto(e.target.value)}
              />
            </div>
            <div>
              <Label>Interessado</Label>
              <Input
                value={interessado}
                onChange={(e) => setInteressado(e.target.value)}
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

      {/* Tramitar */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Tramitar processo {target?.numero}/{target?.ano}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Despacho</Label>
              <textarea
                className="w-full rounded-md border bg-background p-2 text-sm"
                rows={4}
                value={despacho}
                onChange={(e) => setDespacho(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={concluir}
                onCheckedChange={(v) => setConcluir(Boolean(v))}
              />
              Concluir o processo
            </label>
          </div>
          <DialogFooter>
            <Button onClick={submitMove} disabled={busy}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Histórico de tramitação */}
      <Dialog open={histOpen} onOpenChange={setHistOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Tramitação — {histProcess?.numero}/{histProcess?.ano}
            </DialogTitle>
          </DialogHeader>
          <ol className="space-y-3">
            {movements.map((m) => (
              <li
                key={m.id}
                className="rounded-lg border bg-muted/20 p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-medium">
                    {m.unidade_origem ?? "—"} → {m.unidade_destino ?? "—"}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {m.data_movimento.slice(0, 10)}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{m.despacho}</p>
              </li>
            ))}
            {movements.length === 0 && (
              <li className="p-4 text-center text-muted-foreground">
                Sem tramitações registradas.
              </li>
            )}
          </ol>
        </DialogContent>
      </Dialog>
    </section>
  );
}
