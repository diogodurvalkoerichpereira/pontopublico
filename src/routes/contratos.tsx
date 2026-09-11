import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileSignature, Plus, Ruler } from "lucide-react";
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
import {
  getContractMeasurements,
  recordContractMeasurement,
} from "@/lib/contract-measurements.functions";

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
  const loadMeasurements = useServerFn(getContractMeasurements);
  const measure = useServerFn(recordContractMeasurement);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [measureContract, setMeasureContract] = useState<Contract | null>(null);
  const [mForm, setMForm] = useState({
    competencia: new Date().toISOString().slice(0, 7),
    valor: "",
    descricao: "",
  });
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

  const { data: measurements } = useQuery({
    queryKey: ["contract-measurements", activeTenant?.id, expanded],
    enabled: Boolean(activeTenant) && Boolean(expanded),
    queryFn: () =>
      loadMeasurements({
        data: { tenant_id: activeTenant!.id, contract_id: expanded! },
      }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["contracts", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["contract-measurements", activeTenant?.id],
    });
  };

  const submitMeasure = async () => {
    if (!activeTenant || !measureContract) return;
    setBusy(true);
    try {
      await measure({
        data: {
          tenant_id: activeTenant.id,
          contract_id: measureContract.id,
          competencia: mForm.competencia.trim(),
          valor: Number(mForm.valor),
          descricao: mForm.descricao.trim(),
          data_medicao: new Date().toISOString().slice(0, 10),
        },
      });
      toast.success("Medição registrada");
      setMeasureContract(null);
      setMForm({
        competencia: new Date().toISOString().slice(0, 7),
        valor: "",
        descricao: "",
      });
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao medir");
    } finally {
      setBusy(false);
    }
  };

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
              <th className="p-3 font-semibold">Ações</th>
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
                <td className="p-3">
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setExpanded((e) => (e === c.id ? null : c.id))
                      }
                    >
                      {expanded === c.id ? "Ocultar" : "Medições"}
                    </Button>
                    {canManage && c.status === "vigente" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setMeasureContract(c)}
                      >
                        <Ruler className="size-4" /> Medir
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum contrato cadastrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {expanded && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <h2 className="font-bold p-3">Medições do contrato</h2>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Nº</th>
                <th className="p-3 font-semibold">Competência</th>
                <th className="p-3 font-semibold">Descrição</th>
                <th className="p-3 font-semibold text-right">Valor</th>
                <th className="p-3 font-semibold">Recebimento</th>
              </tr>
            </thead>
            <tbody>
              {(measurements?.measurements ?? []).map((m) => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="p-3 tabular-nums">{m.numero}</td>
                  <td className="p-3">{m.competencia}</td>
                  <td className="p-3">{m.descricao}</td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(m.valor)}
                  </td>
                  <td className="p-3 capitalize">{m.recebimento}</td>
                </tr>
              ))}
              {(measurements?.measurements ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="p-6 text-center text-muted-foreground"
                  >
                    Nenhuma medição registrada.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

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

      <Dialog
        open={Boolean(measureContract)}
        onOpenChange={(o) => !o && setMeasureContract(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Medir contrato {measureContract?.numero}/{measureContract?.ano}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Empenhado: {brl(measureContract?.valor_empenhado ?? 0)}. A medição
              acumulada não pode exceder o empenhado.
            </p>
            <div>
              <Label>Competência</Label>
              <Input
                value={mForm.competencia}
                onChange={(e) =>
                  setMForm((f) => ({ ...f, competencia: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Valor</Label>
              <Input
                type="number"
                step="0.01"
                value={mForm.valor}
                onChange={(e) =>
                  setMForm((f) => ({ ...f, valor: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Descrição</Label>
              <Input
                value={mForm.descricao}
                onChange={(e) =>
                  setMForm((f) => ({ ...f, descricao: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitMeasure} disabled={busy || !mForm.valor}>
              Registrar medição
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
