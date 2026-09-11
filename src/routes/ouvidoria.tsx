import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { MessageSquareWarning, Plus, Reply } from "lucide-react";
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
} from "@/lib/ombudsman.functions";

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
  const qc = useQueryClient();

  const [openDialog, setOpenDialog] = useState(false);
  const [respondOpen, setRespondOpen] = useState(false);
  const [target, setTarget] = useState<Manifestation | null>(null);
  const [busy, setBusy] = useState(false);

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

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["ombudsman", activeTenant?.id] });

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
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openRespond(m)}
                      >
                        <Reply className="size-4" /> Responder
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
    </section>
  );
}
