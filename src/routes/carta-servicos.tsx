import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BookOpen, Plus, Eye, EyeOff } from "lucide-react";
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
import { useAuth } from "@/lib/auth-context";
import {
  getCitizenServices,
  saveCitizenService,
  publishCitizenService,
} from "@/lib/citizen-services.functions";

export const Route = createFileRoute("/carta-servicos")({ component: Page });

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

type Service = {
  id: string;
  nome: string;
  descricao: string;
  requisitos: string | null;
  prazo_dias: number;
  canais: string | null;
  taxa: string;
  publicado: boolean;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getCitizenServices);
  const save = useServerFn(saveCitizenService);
  const publish = useServerFn(publishCitizenService);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    nome: "",
    descricao: "",
    requisitos: "",
    prazo_dias: "5",
    canais: "",
    taxa: "0",
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const { data } = useQuery({
    queryKey: ["citizen-services", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const services = (data?.services ?? []) as Service[];
  const canManage = data?.canManage ?? false;

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["citizen-services", activeTenant?.id] });

  const submit = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await save({
        data: {
          tenant_id: activeTenant.id,
          nome: form.nome.trim(),
          descricao: form.descricao.trim(),
          requisitos: form.requisitos.trim() || null,
          prazo_dias: Number(form.prazo_dias || 0),
          canais: form.canais.trim() || null,
          taxa: Number(form.taxa || 0),
        },
      });
      toast.success("Serviço salvo");
      setOpen(false);
      setForm({
        nome: "",
        descricao: "",
        requisitos: "",
        prazo_dias: "5",
        canais: "",
        taxa: "0",
      });
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const togglePublish = async (s: Service) => {
    if (!activeTenant) return;
    try {
      await publish({
        data: {
          tenant_id: activeTenant.id,
          service_id: s.id,
          publicar: !s.publicado,
        },
      });
      toast.success(s.publicado ? "Serviço despublicado" : "Serviço publicado");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao publicar");
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <BookOpen className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Carta de Serviços
            </h1>
            <p className="text-sm text-muted-foreground">
              Serviços ao cidadão (Lei 13.460, art. 7º) — prazo, canais e taxa
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> Novo serviço
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Serviço</th>
              <th className="p-3 font-semibold">Prazo</th>
              <th className="p-3 font-semibold">Canais</th>
              <th className="p-3 font-semibold text-right">Taxa</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr key={s.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{s.nome}</td>
                <td className="p-3 tabular-nums">{s.prazo_dias} dias</td>
                <td className="p-3 text-muted-foreground">{s.canais ?? "—"}</td>
                <td className="p-3 text-right tabular-nums">{brl(s.taxa)}</td>
                <td className="p-3">
                  <Badge variant={s.publicado ? "default" : "secondary"}>
                    {s.publicado ? "publicado" : "rascunho"}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => togglePublish(s)}
                    >
                      {s.publicado ? (
                        <>
                          <EyeOff className="size-4" /> Despublicar
                        </>
                      ) : (
                        <>
                          <Eye className="size-4" /> Publicar
                        </>
                      )}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {services.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 6 : 5}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum serviço cadastrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo serviço</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome</Label>
              <Input
                value={form.nome}
                onChange={(e) => set("nome", e.target.value)}
              />
            </div>
            <div>
              <Label>Descrição</Label>
              <Input
                value={form.descricao}
                onChange={(e) => set("descricao", e.target.value)}
              />
            </div>
            <div>
              <Label>Requisitos</Label>
              <Input
                value={form.requisitos}
                onChange={(e) => set("requisitos", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>Prazo (dias)</Label>
                <Input
                  type="number"
                  value={form.prazo_dias}
                  onChange={(e) => set("prazo_dias", e.target.value)}
                />
              </div>
              <div>
                <Label>Taxa</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.taxa}
                  onChange={(e) => set("taxa", e.target.value)}
                />
              </div>
              <div>
                <Label>Canais</Label>
                <Input
                  value={form.canais}
                  onChange={(e) => set("canais", e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submit} disabled={busy}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
