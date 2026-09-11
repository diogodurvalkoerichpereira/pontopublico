import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileSignature, Plus } from "lucide-react";
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
import { getContracts, saveContract } from "@/lib/contracts.functions";

export const Route = createFileRoute("/contratos")({ component: Page });

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

type Contract = {
  id: string;
  numero: string;
  ano: number;
  fornecedor: string;
  objeto: string;
  modalidade: string;
  valor_total: string;
  valor_empenhado: string;
  saldo: string;
  vigencia_inicio: string;
  vigencia_fim: string;
  status: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
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
const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  vigente: "default",
  suspenso: "outline",
  encerrado: "secondary",
  rescindido: "destructive",
};

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getContracts);
  const save = useServerFn(saveContract);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    numero: "",
    ano: String(new Date().getFullYear()),
    fornecedor: "",
    fornecedor_documento: "",
    objeto: "",
    modalidade: "pregao" as (typeof modalidades)[number],
    valor_total: "",
    vigencia_inicio: "",
    vigencia_fim: "",
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const { data } = useQuery({
    queryKey: ["contracts", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data?.contracts ?? []) as Contract[];
  const canManage = data?.canManage ?? false;

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["contracts", activeTenant?.id] });

  const submit = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await save({
        data: {
          tenant_id: activeTenant.id,
          numero: form.numero.trim(),
          ano: Number(form.ano),
          fornecedor: form.fornecedor.trim(),
          fornecedor_documento: form.fornecedor_documento.trim(),
          objeto: form.objeto.trim(),
          modalidade: form.modalidade,
          valor_total: Number(form.valor_total),
          vigencia_inicio: form.vigencia_inicio,
          vigencia_fim: form.vigencia_fim,
          status: "vigente",
        },
      });
      toast.success("Contrato salvo");
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <FileSignature className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Contratos
            </h1>
            <p className="text-sm text-muted-foreground">
              Contratos administrativos (Lei 14.133) — valor, vigência e saldo
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> Novo contrato
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Nº/Ano</th>
              <th className="p-3 font-semibold">Fornecedor</th>
              <th className="p-3 font-semibold">Modalidade</th>
              <th className="p-3 font-semibold text-right">Valor</th>
              <th className="p-3 font-semibold text-right">Empenhado</th>
              <th className="p-3 font-semibold text-right">Saldo</th>
              <th className="p-3 font-semibold">Vigência</th>
              <th className="p-3 font-semibold">Situação</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className="border-b last:border-0">
                <td className="p-3 font-medium tabular-nums">
                  {c.numero}/{c.ano}
                </td>
                <td className="p-3">{c.fornecedor}</td>
                <td className="p-3 capitalize">
                  {c.modalidade.replace("_", " ")}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(c.valor_total)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(c.valor_empenhado)}
                </td>
                <td className="p-3 text-right tabular-nums">{brl(c.saldo)}</td>
                <td className="p-3 text-muted-foreground tabular-nums">
                  {c.vigencia_inicio} a {c.vigencia_fim}
                </td>
                <td className="p-3">
                  <Badge variant={statusVariant[c.status] ?? "secondary"}>
                    {c.status}
                  </Badge>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum contrato cadastrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo contrato</DialogTitle>
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
            <div>
              <Label>Fornecedor</Label>
              <Input
                value={form.fornecedor}
                onChange={(e) => set("fornecedor", e.target.value)}
              />
            </div>
            <div>
              <Label>Documento</Label>
              <Input
                value={form.fornecedor_documento}
                onChange={(e) => set("fornecedor_documento", e.target.value)}
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
              <Label>Valor total</Label>
              <Input
                type="number"
                step="0.01"
                value={form.valor_total}
                onChange={(e) => set("valor_total", e.target.value)}
              />
            </div>
            <div>
              <Label>Vigência início</Label>
              <Input
                type="date"
                value={form.vigencia_inicio}
                onChange={(e) => set("vigencia_inicio", e.target.value)}
              />
            </div>
            <div>
              <Label>Vigência fim</Label>
              <Input
                type="date"
                value={form.vigencia_fim}
                onChange={(e) => set("vigencia_fim", e.target.value)}
              />
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
