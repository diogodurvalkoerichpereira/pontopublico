import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  PiggyBank,
  Plus,
  CalendarClock,
  Lock,
  Unlock,
  TrendingUp,
  ArrowLeftRight,
} from "lucide-react";
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
  getBudgetExecution,
} from "@/lib/budget.functions";
import {
  getBudgetCreditMovements,
  transferBudgetCredit,
} from "@/lib/budget-credit.functions";
import {
  getDisbursementSchedule,
  saveDisbursementQuota,
  getDisbursementProgress,
} from "@/lib/disbursement-schedule.functions";
import {
  contingenciarDotacao,
  descontingenciarDotacao,
} from "@/lib/budget-contingency.functions";
import {
  openSupplementaryCredit,
  getExcessRevenueAvailable,
  getSupplementaryCredits,
} from "@/lib/supplementary-credit.functions";

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

import { AppShell } from "@/components/AppShell";

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
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
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
  // O2-28/29/30 — execução, liberação do contingenciamento e remanejamento de
  // crédito. Estavam no servidor sem tela: a dotação não tinha como ser liberada
  // depois de bloqueada, nem remanejada, e o quadro de execução não existia.
  const descontingenciar = useServerFn(descontingenciarDotacao);
  const remanejar = useServerFn(transferBudgetCredit);
  const loadExecution = useServerFn(getBudgetExecution);
  const loadCreditMovements = useServerFn(getBudgetCreditMovements);
  const loadSupplementary = useServerFn(getSupplementaryCredits);
  const [unblockTarget, setUnblockTarget] = useState<Appropriation | null>(
    null,
  );
  const [unblockForm, setUnblockForm] = useState({ valor: "", motivo: "" });
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferForm, setTransferForm] = useState({
    origem_id: "",
    destino_id: "",
    valor: "",
    justificativa: "",
  });
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

  const loadProgress = useServerFn(getDisbursementProgress);
  const mesAtual = new Date().getMonth() + 1;
  const { data: progress } = useQuery({
    queryKey: ["disbursement-progress", activeTenant?.id, scheduleYear],
    enabled: Boolean(activeTenant) && /^\d{4}$/.test(scheduleYear),
    queryFn: () =>
      loadProgress({
        data: {
          tenant_id: activeTenant!.id,
          exercicio: Number(scheduleYear),
          ate_mes: mesAtual,
        },
      }),
  });

  const loadExcess = useServerFn(getExcessRevenueAvailable);
  const { data: excess } = useQuery({
    queryKey: ["excess-revenue", activeTenant?.id, scheduleYear],
    enabled: Boolean(activeTenant) && /^\d{4}$/.test(scheduleYear),
    queryFn: () =>
      loadExcess({
        data: { tenant_id: activeTenant!.id, exercicio: Number(scheduleYear) },
      }),
  });

  const refreshSchedule = () => {
    qc.invalidateQueries({
      queryKey: ["disbursement-schedule", activeTenant?.id, scheduleYear],
    });
    qc.invalidateQueries({
      queryKey: ["disbursement-progress", activeTenant?.id, scheduleYear],
    });
    qc.invalidateQueries({
      queryKey: ["excess-revenue", activeTenant?.id, scheduleYear],
    });
  };

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

  const { data: execution } = useQuery({
    queryKey: ["budget-execution", activeTenant?.id, scheduleYear],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadExecution({
        data: { tenant_id: activeTenant!.id, exercicio: Number(scheduleYear) },
      }),
  });
  const { data: creditMovements } = useQuery({
    queryKey: ["budget-credit-movements", activeTenant?.id, scheduleYear],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadCreditMovements({
        data: { tenant_id: activeTenant!.id, exercicio: Number(scheduleYear) },
      }),
  });
  const { data: supplementary } = useQuery({
    queryKey: ["supplementary-credits", activeTenant?.id, scheduleYear],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadSupplementary({
        data: { tenant_id: activeTenant!.id, exercicio: Number(scheduleYear) },
      }),
  });

  const refreshCredits = () => {
    refreshAppropriations();
    qc.invalidateQueries({
      queryKey: ["budget-execution", activeTenant?.id, scheduleYear],
    });
    qc.invalidateQueries({
      queryKey: ["budget-credit-movements", activeTenant?.id, scheduleYear],
    });
    qc.invalidateQueries({
      queryKey: ["supplementary-credits", activeTenant?.id, scheduleYear],
    });
  };

  const submitUnblock = async () => {
    if (!activeTenant || !unblockTarget) return;
    setBusy(true);
    try {
      const r = await descontingenciar({
        data: {
          tenant_id: activeTenant.id,
          appropriation_id: unblockTarget.id,
          valor: Number(unblockForm.valor),
          motivo: unblockForm.motivo.trim(),
        },
      });
      toast.success(
        `Contingenciamento liberado — restam ${brl(r.valor_bloqueado)} bloqueados`,
      );
      setUnblockTarget(null);
      setUnblockForm({ valor: "", motivo: "" });
      refreshCredits();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao liberar");
    } finally {
      setBusy(false);
    }
  };

  const submitTransfer = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await remanejar({
        data: {
          tenant_id: activeTenant.id,
          origem_id: transferForm.origem_id,
          destino_id: transferForm.destino_id,
          valor: Number(transferForm.valor),
          data_referencia: new Date().toISOString().slice(0, 10),
          justificativa: transferForm.justificativa.trim(),
        },
      });
      toast.success("Crédito remanejado");
      setTransferOpen(false);
      setTransferForm({
        origem_id: "",
        destino_id: "",
        valor: "",
        justificativa: "",
      });
      refreshCredits();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao remanejar",
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
                    {Number(a.valor_bloqueado) > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-2"
                        onClick={() => {
                          setUnblockTarget(a);
                          setUnblockForm({
                            valor: a.valor_bloqueado,
                            motivo: "",
                          });
                        }}
                      >
                        <Unlock className="size-4" /> Liberar
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

      {/* Quadro da execução orçamentária da despesa (Lei 4.320) */}
      {execution && execution.rows.length > 0 && (
        <div className="rounded-xl border bg-card">
          <h2 className="font-bold p-3">
            Execução da despesa — exercício {scheduleYear}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-3 font-semibold">Unidade</th>
                  <th className="p-3 font-semibold">Natureza</th>
                  <th className="p-3 font-semibold text-right">Orçado</th>
                  <th className="p-3 font-semibold text-right">
                    Contingenciado
                  </th>
                  <th className="p-3 font-semibold text-right">Empenhado</th>
                  <th className="p-3 font-semibold text-right">Liquidado</th>
                  <th className="p-3 font-semibold text-right">Pago</th>
                  <th className="p-3 font-semibold text-right">A pagar</th>
                  <th className="p-3 font-semibold text-right">Restos</th>
                  <th className="p-3 font-semibold text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {execution.rows.map((r) => (
                  <tr
                    key={r.appropriation_id}
                    className="border-b last:border-0"
                  >
                    <td className="p-3">{r.unidade_orcamentaria}</td>
                    <td className="p-3 tabular-nums">{r.natureza_despesa}</td>
                    <td className="p-3 text-right tabular-nums">
                      {brl(r.valor_orcado)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {brl(r.bloqueado)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {brl(r.empenhado)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {brl(r.liquidado)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {brl(r.pago)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {brl(r.a_pagar)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {brl(r.restos_a_pagar)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {brl(r.saldo_dotacao)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="p-3" colSpan={2}>
                    Total
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(execution.totais.orcado)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(execution.totais.bloqueado)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(execution.totais.empenhado)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(execution.totais.liquidado)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(execution.totais.pago)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(execution.totais.a_pagar)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(execution.totais.restos_a_pagar)}
                  </td>
                  <td className="p-3" />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="px-3 pb-3 text-xs text-muted-foreground">
            "A pagar" é o empenhado do exercício ainda não pago. "Restos" são os
            já <strong>inscritos</strong> em restos a pagar (Lei 4.320 art. 36)
            — são coisas diferentes e não se somam.
          </p>
        </div>
      )}

      {/* Créditos adicionais do exercício (Lei 4.320 art. 40-43) */}
      <div className="rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-3 flex-wrap p-3">
          <h2 className="font-bold">
            Créditos adicionais — exercício {scheduleYear}
          </h2>
          {canManage && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTransferOpen(true)}
              disabled={items.filter((a) => a.status === "ativa").length < 2}
            >
              <ArrowLeftRight className="size-4" /> Remanejar
            </Button>
          )}
        </div>
        <div className="grid gap-4 lg:grid-cols-2 p-3 pt-0">
          <div className="rounded-lg border overflow-x-auto">
            <div className="p-2 text-sm font-semibold border-b bg-muted/40">
              Remanejamentos (art. 42-43)
            </div>
            <table className="w-full text-sm">
              <thead className="border-b text-left">
                <tr>
                  <th className="p-2 font-semibold">Data</th>
                  <th className="p-2 font-semibold text-right">Valor</th>
                  <th className="p-2 font-semibold">Justificativa</th>
                </tr>
              </thead>
              <tbody>
                {(creditMovements?.movements ?? []).map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="p-2 tabular-nums">{m.data_referencia}</td>
                    <td className="p-2 text-right tabular-nums">
                      {brl(m.valor)}
                    </td>
                    <td className="p-2">{m.justificativa}</td>
                  </tr>
                ))}
                {(creditMovements?.movements ?? []).length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="p-4 text-center text-muted-foreground"
                    >
                      Nenhum remanejamento no exercício.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="rounded-lg border overflow-x-auto">
            <div className="p-2 text-sm font-semibold border-b bg-muted/40">
              Créditos suplementares (art. 43)
            </div>
            <table className="w-full text-sm">
              <thead className="border-b text-left">
                <tr>
                  <th className="p-2 font-semibold">Data</th>
                  <th className="p-2 font-semibold">Fonte</th>
                  <th className="p-2 font-semibold">Tipo</th>
                  <th className="p-2 font-semibold text-right">Valor</th>
                </tr>
              </thead>
              <tbody>
                {(supplementary?.credits ?? []).map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="p-2 tabular-nums">{c.data_referencia}</td>
                    <td className="p-2">{c.fonte_recurso}</td>
                    <td className="p-2">{c.tipo}</td>
                    <td className="p-2 text-right tabular-nums">
                      {brl(c.valor)}
                    </td>
                  </tr>
                ))}
                {(supplementary?.credits ?? []).length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="p-4 text-center text-muted-foreground"
                    >
                      Nenhum crédito suplementar no exercício.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
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
        {progress && (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm flex flex-wrap gap-x-6 gap-y-1">
            <span>
              Até {MESES[progress.ate_mes - 1]}: programado{" "}
              <b className="tabular-nums">{brl(progress.programado)}</b> ·
              realizado{" "}
              <b className="tabular-nums">{brl(progress.realizado)}</b> (
              {progress.percentualExecucao}%)
            </span>
            <span
              className={
                progress.dentroDoCronograma
                  ? "text-primary"
                  : "text-red-600 font-semibold"
              }
            >
              {progress.dentroDoCronograma
                ? "dentro do cronograma"
                : "acima do programado"}
            </span>
          </div>
        )}
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

      {/* Liberação do contingenciamento (LRF art. 9º, §1º) */}
      <Dialog
        open={Boolean(unblockTarget)}
        onOpenChange={(o) => !o && setUnblockTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Liberar contingenciamento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Bloqueado hoje: {brl(unblockTarget?.valor_bloqueado ?? 0)}. A
              liberação devolve a dotação ao saldo empenhável.
            </p>
            <div>
              <Label>Valor a liberar</Label>
              <Input
                type="number"
                step="0.01"
                value={unblockForm.valor}
                onChange={(e) =>
                  setUnblockForm((f) => ({ ...f, valor: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Motivo</Label>
              <Input
                value={unblockForm.motivo}
                onChange={(e) =>
                  setUnblockForm((f) => ({ ...f, motivo: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitUnblock}
              disabled={
                busy ||
                !(Number(unblockForm.valor) > 0) ||
                unblockForm.motivo.trim().length < 3
              }
            >
              Liberar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remanejamento de crédito (Lei 4.320 art. 42-43) */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remanejar crédito entre dotações</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Origem (anula)</Label>
              <Select
                value={transferForm.origem_id}
                onValueChange={(v) =>
                  setTransferForm((f) => ({ ...f, origem_id: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  {items
                    .filter((a) => a.status === "ativa")
                    .map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.unidade_orcamentaria} · {a.natureza_despesa} —{" "}
                        {brl(a.saldo)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Destino (suplementa)</Label>
              <Select
                value={transferForm.destino_id}
                onValueChange={(v) =>
                  setTransferForm((f) => ({ ...f, destino_id: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  {items
                    .filter(
                      (a) =>
                        a.status === "ativa" && a.id !== transferForm.origem_id,
                    )
                    .map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.unidade_orcamentaria} · {a.natureza_despesa}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Valor</Label>
              <Input
                type="number"
                step="0.01"
                value={transferForm.valor}
                onChange={(e) =>
                  setTransferForm((f) => ({ ...f, valor: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Justificativa</Label>
              <Input
                value={transferForm.justificativa}
                onChange={(e) =>
                  setTransferForm((f) => ({
                    ...f,
                    justificativa: e.target.value,
                  }))
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              A origem nunca fica abaixo do já empenhado; as duas dotações têm
              de ser do mesmo exercício e estar ativas.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={submitTransfer}
              disabled={
                busy ||
                !transferForm.origem_id ||
                !transferForm.destino_id ||
                !(Number(transferForm.valor) > 0) ||
                transferForm.justificativa.trim().length < 5
              }
            >
              Remanejar
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
          {excess && (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="mb-1 font-medium">
                Excesso de arrecadação disponível ({scheduleYear})
              </div>
              {excess.fontes.length === 0 ? (
                <p className="text-muted-foreground">
                  Nenhuma fonte com excesso de arrecadação.
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {excess.fontes.map((f) => (
                    <li
                      key={f.fonte_recurso}
                      className="flex justify-between tabular-nums"
                    >
                      <span>Fonte {f.fonte_recurso}</span>
                      <span>
                        disponível <b>{brl(f.disponivel)}</b> de{" "}
                        {brl(f.excesso)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
