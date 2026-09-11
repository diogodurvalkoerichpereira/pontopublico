import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PiggyBank, Plus, CalendarClock, Lock, TrendingUp } from "lucide-react";
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
  getBudgetAppropriations,
  saveBudgetAppropriation,
} from "@/lib/budget.functions";
import {
  getDisbursementSchedule,
  saveDisbursementQuota,
} from "@/lib/disbursement-schedule.functions";
import { contingenciarDotacao } from "@/lib/budget-contingency.functions";
import { openSupplementaryCredit } from "@/lib/supplementary-credit.functions";

const MESES = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez",
];

export const Route = createFileRoute("/orcamento")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("budget.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Appropriation = {
  id: string;
  exercicio: number;
  unidade_orcamentaria: string;
  funcao: string;
  subfuncao: string;
  programa: string;
  acao: string;
  natureza_despesa: string;
  fonte_recurso: string;
  valor_orcado: string;
  valor_empenhado: string;
  valor_bloqueado: string;
  saldo: string;
  status: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getBudgetAppropriations);
  const save = useServerFn(saveBudgetAppropriation);
  const loadSchedule = useServerFn(getDisbursementSchedule);
  const saveQuota = useServerFn(saveDisbursementQuota);
  const contingenciar = useServerFn(contingenciarDotacao);
  const suplementar = useServerFn(openSupplementaryCredit);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blockTarget, setBlockTarget] = useState<Appropriation | null>(null);
  const [blockForm, setBlockForm] = useState({ valor: "", motivo: "" });
  const [suppOpen, setSuppOpen] = useState(false);
  const [suppForm, setSuppForm] = useState({
    destino_id: "",
    fonte_recurso: "",
    valor: "",
    justificativa: "",
  });
  const [scheduleYear, setScheduleYear] = useState(
    String(new Date().getFullYear()),
  );
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [quota, setQuota] = useState({
    mes: "1",
    fonte_recurso: "",
    valor: "",
  });
  const [form, setForm] = useState({
    exercicio: String(new Date().getFullYear()),
    unidade_orcamentaria: "",
    funcao: "",
    subfuncao: "",
    programa: "",
    acao: "",
    natureza_despesa: "",
    fonte_recurso: "",
    valor_orcado: "",
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const { data } = useQuery({
    queryKey: ["budget-appropriations", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data?.appropriations ?? []) as Appropriation[];
  const canManage = data?.canManage ?? false;

  const { data: schedule } = useQuery({
    queryKey: ["disbursement-schedule", activeTenant?.id, scheduleYear],
    enabled: Boolean(activeTenant) && /^\d{4}$/.test(scheduleYear),
    queryFn: () =>
      loadSchedule({
        data: { tenant_id: activeTenant!.id, exercicio: Number(scheduleYear) },
      }),
  });

  const refreshSchedule = () =>
    qc.invalidateQueries({
      queryKey: ["disbursement-schedule", activeTenant?.id, scheduleYear],
    });

  const refreshAppropriations = () =>
    qc.invalidateQueries({
      queryKey: ["budget-appropriations", activeTenant?.id],
    });

  const submitBlock = async () => {
    if (!activeTenant || !blockTarget) return;
    setBusy(true);
    try {
      await contingenciar({
        data: {
          tenant_id: activeTenant.id,
          appropriation_id: blockTarget.id,
          valor: Number(blockForm.valor),
          motivo: blockForm.motivo.trim(),
        },
      });
      toast.success("Dotação contingenciada");
      setBlockTarget(null);
      setBlockForm({ valor: "", motivo: "" });
      refreshAppropriations();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao contingenciar",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitSupp = async () => {
    if (!activeTenant || !suppForm.destino_id) return;
    setBusy(true);
    try {
      await suplementar({
        data: {
          tenant_id: activeTenant.id,
          destino_id: suppForm.destino_id,
          fonte_recurso: suppForm.fonte_recurso.trim(),
          valor: Number(suppForm.valor),
          data_referencia: new Date().toISOString().slice(0, 10),
          justificativa: suppForm.justificativa.trim(),
        },
      });
      toast.success("Crédito suplementar aberto");
      setSuppOpen(false);
      setSuppForm({
        destino_id: "",
        fonte_recurso: "",
        valor: "",
        justificativa: "",
      });
      refreshAppropriations();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha no crédito suplementar",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitQuota = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await saveQuota({
        data: {
          tenant_id: activeTenant.id,
          exercicio: Number(scheduleYear),
          mes: Number(quota.mes),
          fonte_recurso: quota.fonte_recurso.trim(),
          valor_programado: Number(quota.valor),
        },
      });
      toast.success("Cota programada");
      setQuotaOpen(false);
      setQuota({ mes: "1", fonte_recurso: "", valor: "" });
      refreshSchedule();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao programar",
      );
    } finally {
      setBusy(false);
    }
  };

  const totals = items.reduce(
    (acc, a) => ({
      orcado: acc.orcado + Number(a.valor_orcado),
      empenhado: acc.empenhado + Number(a.valor_empenhado),
      saldo: acc.saldo + Number(a.saldo),
    }),
    { orcado: 0, empenhado: 0, saldo: 0 },
  );

  const refresh = () =>
    qc.invalidateQueries({
      queryKey: ["budget-appropriations", activeTenant?.id],
    });

  const submit = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await save({
        data: {
          tenant_id: activeTenant.id,
          exercicio: Number(form.exercicio),
          unidade_orcamentaria: form.unidade_orcamentaria.trim(),
          funcao: form.funcao.trim(),
          subfuncao: form.subfuncao.trim(),
          programa: form.programa.trim(),
          acao: form.acao.trim(),
          natureza_despesa: form.natureza_despesa.trim(),
          fonte_recurso: form.fonte_recurso.trim(),
          valor_orcado: Number(form.valor_orcado),
          status: "ativa",
        },
      });
      toast.success("Dotação salva");
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const campos: Array<[keyof typeof form, string]> = [
    ["exercicio", "Exercício"],
    ["unidade_orcamentaria", "Unidade orçamentária"],
    ["funcao", "Função"],
    ["subfuncao", "Subfunção"],
    ["programa", "Programa"],
    ["acao", "Ação"],
    ["natureza_despesa", "Natureza da despesa"],
    ["fonte_recurso", "Fonte de recurso"],
    ["valor_orcado", "Valor orçado"],
  ];

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <PiggyBank className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Orçamento
            </h1>
            <p className="text-sm text-muted-foreground">
              Dotações orçamentárias (LOA) — orçado, empenhado e saldo
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => setSuppOpen(true)}
              disabled={items.length === 0}
            >
              <TrendingUp className="size-4" /> Crédito suplementar
            </Button>
            <Button variant="outline" onClick={() => setOpen(true)}>
              <Plus className="size-4" /> Nova dotação
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">Orçado</div>
          <div className="text-xl font-bold">{brl(totals.orcado)}</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">Empenhado</div>
          <div className="text-xl font-bold">{brl(totals.empenhado)}</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">Saldo</div>
          <div className="text-xl font-bold">{brl(totals.saldo)}</div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Exerc.</th>
              <th className="p-3 font-semibold">Unidade</th>
              <th className="p-3 font-semibold">Natureza</th>
              <th className="p-3 font-semibold">Fonte</th>
              <th className="p-3 font-semibold text-right">Orçado</th>
              <th className="p-3 font-semibold text-right">Empenhado</th>
              <th className="p-3 font-semibold text-right">Bloqueado</th>
              <th className="p-3 font-semibold text-right">Saldo</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id} className="border-b last:border-0">
                <td className="p-3">{a.exercicio}</td>
                <td className="p-3 font-medium">{a.unidade_orcamentaria}</td>
                <td className="p-3 text-muted-foreground">
                  {a.natureza_despesa}
                </td>
                <td className="p-3 text-muted-foreground">{a.fonte_recurso}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(a.valor_orcado)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(a.valor_empenhado)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(a.valor_bloqueado)}
                </td>
                <td className="p-3 text-right tabular-nums">{brl(a.saldo)}</td>
                <td className="p-3">
                  <Badge
                    variant={a.status === "ativa" ? "default" : "secondary"}
                  >
                    {a.status}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    {a.status === "ativa" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setBlockTarget(a);
                          setBlockForm({ valor: "", motivo: "" });
                        }}
                      >
                        <Lock className="size-4" /> Contingenciar
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 10 : 9}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhuma dotação cadastrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-5 text-primary" />
            <h2 className="font-bold">
              Cronograma de desembolso (Lei 4.320, art. 47-50)
            </h2>
          </div>
          <div className="flex items-end gap-2">
            <div className="w-28">
              <Label>Exercício</Label>
              <Input
                type="number"
                value={scheduleYear}
                onChange={(e) => setScheduleYear(e.target.value)}
              />
            </div>
            {canManage && (
              <Button variant="outline" onClick={() => setQuotaOpen(true)}>
                <Plus className="size-4" /> Programar cota
              </Button>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-2 font-semibold">Mês</th>
                <th className="p-2 font-semibold text-right">Programado</th>
                <th className="p-2 font-semibold text-right">Realizado</th>
                <th className="p-2 font-semibold text-right">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {(schedule?.meses ?? []).map((m) => (
                <tr key={m.mes} className="border-b last:border-0">
                  <td className="p-2">{MESES[m.mes - 1]}</td>
                  <td className="p-2 text-right tabular-nums">
                    {brl(m.programado)}
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {brl(m.realizado)}
                  </td>
                  <td
                    className={`p-2 text-right tabular-nums ${
                      m.saldo < 0 ? "text-red-600" : ""
                    }`}
                  >
                    {brl(m.saldo)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-bold">
                <td className="p-2">Total</td>
                <td className="p-2 text-right tabular-nums">
                  {brl(schedule?.totais.programado ?? 0)}
                </td>
                <td className="p-2 text-right tabular-nums">
                  {brl(schedule?.totais.realizado ?? 0)}
                </td>
                <td className="p-2 text-right tabular-nums">
                  {brl(schedule?.totais.saldo ?? 0)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <Dialog open={quotaOpen} onOpenChange={setQuotaOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Programar cota de desembolso</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Mês</Label>
              <Input
                type="number"
                min={1}
                max={12}
                value={quota.mes}
                onChange={(e) =>
                  setQuota((q) => ({ ...q, mes: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Fonte de recurso</Label>
              <Input
                value={quota.fonte_recurso}
                onChange={(e) =>
                  setQuota((q) => ({ ...q, fonte_recurso: e.target.value }))
                }
              />
            </div>
            <div className="col-span-2">
              <Label>Valor programado</Label>
              <Input
                type="number"
                step="0.01"
                value={quota.valor}
                onChange={(e) =>
                  setQuota((q) => ({ ...q, valor: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitQuota} disabled={busy}>
              Programar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova dotação</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {campos.map(([k, label]) => (
              <div key={k}>
                <Label>{label}</Label>
                <Input
                  type={
                    k === "exercicio" || k === "valor_orcado"
                      ? "number"
                      : "text"
                  }
                  step={k === "valor_orcado" ? "0.01" : undefined}
                  value={form[k]}
                  onChange={(e) => set(k, e.target.value)}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={submit} disabled={busy}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Contingenciamento (LRF art. 9) */}
      <Dialog
        open={Boolean(blockTarget)}
        onOpenChange={(o) => !o && setBlockTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Contingenciar dotação</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Saldo empenhável: {brl(blockTarget?.saldo ?? 0)}. O bloqueio não
              invade o já empenhado.
            </p>
            <div>
              <Label>Valor a bloquear</Label>
              <Input
                type="number"
                step="0.01"
                value={blockForm.valor}
                onChange={(e) =>
                  setBlockForm((f) => ({ ...f, valor: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Motivo</Label>
              <Input
                value={blockForm.motivo}
                onChange={(e) =>
                  setBlockForm((f) => ({ ...f, motivo: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitBlock} disabled={busy || !blockForm.valor}>
              Contingenciar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Crédito suplementar por excesso de arrecadação (art. 43) */}
      <Dialog open={suppOpen} onOpenChange={setSuppOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Crédito suplementar (excesso de arrecadação)
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Dotação de destino</Label>
              <Select
                value={suppForm.destino_id}
                onValueChange={(v) =>
                  setSuppForm((f) => ({ ...f, destino_id: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a dotação" />
                </SelectTrigger>
                <SelectContent>
                  {items
                    .filter((a) => a.status === "ativa")
                    .map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.unidade_orcamentaria} — {a.natureza_despesa} (
                        {a.fonte_recurso})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Fonte de recurso</Label>
                <Input
                  value={suppForm.fonte_recurso}
                  onChange={(e) =>
                    setSuppForm((f) => ({
                      ...f,
                      fonte_recurso: e.target.value,
                    }))
                  }
                />
              </div>
              <div>
                <Label>Valor</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={suppForm.valor}
                  onChange={(e) =>
                    setSuppForm((f) => ({ ...f, valor: e.target.value }))
                  }
                />
              </div>
            </div>
            <div>
              <Label>Justificativa</Label>
              <Input
                value={suppForm.justificativa}
                onChange={(e) =>
                  setSuppForm((f) => ({
                    ...f,
                    justificativa: e.target.value,
                  }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitSupp}
              disabled={busy || !suppForm.destino_id}
            >
              Abrir crédito
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
