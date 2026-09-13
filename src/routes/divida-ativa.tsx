import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Scale, Gavel, CheckCircle2, Ban } from "lucide-react";
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
  getActiveDebtCertificates,
  getActiveDebtByTaxpayer,
  getActiveDebtAging,
  settleActiveDebtCertificate,
  cancelActiveDebtCertificate,
} from "@/lib/active-debt-certificate.functions";
import {
  getFiscalExecutions,
  fileFiscalExecution,
  updateFiscalExecutionStatus,
} from "@/lib/fiscal-execution.functions";
import { getTaxRevenueByOrigin } from "@/lib/taxes.functions";

export const Route = createFileRoute("/divida-ativa")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("taxes.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Cda = {
  id: string;
  exercicio: number;
  numero: string;
  valor_inscrito: string;
  data_inscricao: string;
  fundamento_legal: string;
  status: string;
};
type Execution = {
  id: string;
  cda_numero: string;
  numero_processo: string;
  data_ajuizamento: string;
  valor_ajuizado: string;
  status: string;
};
type TaxpayerDebt = {
  contribuinte: string;
  contribuinte_documento: string;
  qtd_cdas: number;
  total_inscrito: number;
  total_ativa: number;
  total_quitada: number;
  total_cancelada: number;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);

function Content() {
  const { activeTenant } = useAuth();
  const loadCdas = useServerFn(getActiveDebtCertificates);
  const loadByTaxpayer = useServerFn(getActiveDebtByTaxpayer);
  const loadExecs = useServerFn(getFiscalExecutions);
  const file = useServerFn(fileFiscalExecution);
  const updateStatus = useServerFn(updateFiscalExecutionStatus);
  const settle = useServerFn(settleActiveDebtCertificate);
  const cancelCda = useServerFn(cancelActiveDebtCertificate);
  const qc = useQueryClient();

  const [target, setTarget] = useState<Cda | null>(null);
  const [processo, setProcesso] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: cdaData } = useQuery({
    queryKey: ["cdas", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadCdas({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: execData } = useQuery({
    queryKey: ["fiscal-executions", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadExecs({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: byTaxpayer } = useQuery({
    queryKey: ["active-debt-by-taxpayer", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadByTaxpayer({ data: { tenant_id: activeTenant!.id } }),
  });
  const contribuintes = (byTaxpayer?.contribuintes ?? []) as TaxpayerDebt[];
  const saldoEmCobranca = byTaxpayer?.saldoEmCobranca ?? 0;

  const loadAging = useServerFn(getActiveDebtAging);
  const { data: aging } = useQuery({
    queryKey: ["active-debt-aging", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadAging({
        data: {
          tenant_id: activeTenant!.id,
          ano_referencia: new Date().getFullYear(),
        },
      }),
  });

  // O4-14c — receita de dívida ativa arrecadada no exercício corrente.
  const loadOrigin = useServerFn(getTaxRevenueByOrigin);
  const { data: origin } = useQuery({
    queryKey: ["tax-revenue-origin", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadOrigin({
        data: {
          tenant_id: activeTenant!.id,
          exercicio: new Date().getFullYear(),
        },
      }),
  });

  const cdas = (cdaData?.certificates ?? []) as Cda[];
  const executions = useMemo(
    () => (execData?.executions ?? []) as Execution[],
    [execData],
  );
  const canManage = cdaData?.canManage ?? false;
  // CDAs já ajuizadas não podem ser ajuizadas de novo.
  const ajuizadas = useMemo(
    () => new Set(executions.map((e) => e.cda_numero)),
    [executions],
  );

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["cdas", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["fiscal-executions", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["active-debt-by-taxpayer", activeTenant?.id],
    });
    qc.invalidateQueries({ queryKey: ["active-debt-aging", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["tax-revenue-origin", activeTenant?.id],
    });
  };

  const doSettle = async (c: Cda) => {
    if (!activeTenant) return;
    if (!window.confirm("Baixar a CDA por quitação do crédito?")) return;
    try {
      await settle({
        data: { tenant_id: activeTenant.id, certificate_id: c.id },
      });
      toast.success("CDA baixada (quitada)");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao baixar");
    }
  };

  const doCancel = async (c: Cda) => {
    if (!activeTenant) return;
    const motivo = window.prompt("Motivo do cancelamento da CDA:");
    if (!motivo || motivo.trim().length < 3) return;
    try {
      await cancelCda({
        data: {
          tenant_id: activeTenant.id,
          certificate_id: c.id,
          motivo: motivo.trim(),
        },
      });
      toast.success("CDA cancelada");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao cancelar");
    }
  };

  const submitFile = async () => {
    if (!activeTenant || !target) return;
    setBusy(true);
    try {
      const r = await file({
        data: {
          tenant_id: activeTenant.id,
          cda_id: target.id,
          numero_processo: processo.trim(),
          data_ajuizamento: hoje(),
        },
      });
      toast.success(`Execução ajuizada — ${brl(r.valor_ajuizado)}`);
      setTarget(null);
      setProcesso("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao ajuizar");
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (e: Execution, status: string) => {
    if (!activeTenant) return;
    try {
      await updateStatus({
        data: {
          tenant_id: activeTenant.id,
          execution_id: e.id,
          status: status as "suspensa" | "extinta" | "quitada" | "ajuizada",
        },
      });
      toast.success("Andamento atualizado");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao atualizar",
      );
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3">
        <Scale className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            Dívida ativa
          </h1>
          <p className="text-sm text-muted-foreground">
            Certidões de dívida ativa (CDA) e execuções fiscais (Lei 6.830)
          </p>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="text-sm text-muted-foreground">
          Saldo em cobrança (CDAs ativas)
        </div>
        <div className="text-2xl font-bold">{brl(saldoEmCobranca)}</div>
      </div>

      {aging && aging.total.quantidade > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <h2 className="font-bold">Idade da dívida ativa (aging)</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Estoque em cobrança por faixa etária — base da provisão para perdas
            (NBC TSP).
          </p>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { rotulo: "No exercício", f: aging.faixas.no_exercicio },
              { rotulo: "1 a 2 anos", f: aging.faixas.de_1_a_2 },
              { rotulo: "3 a 5 anos", f: aging.faixas.de_3_a_5 },
              { rotulo: "Mais de 5 anos", f: aging.faixas.mais_de_5 },
            ].map(({ rotulo, f }) => (
              <div key={rotulo} className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">{rotulo}</div>
                <div className="text-lg font-bold tabular-nums">
                  {brl(f.valor)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {f.quantidade} CDA(s)
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card p-4">
        <div className="text-sm text-muted-foreground">
          Receita de dívida ativa arrecadada em{" "}
          {origin?.exercicio ?? new Date().getFullYear()}
        </div>
        <div className="text-2xl font-bold">
          {brl(origin?.totais.divida_ativa ?? 0)}
          <span className="text-sm font-normal text-muted-foreground">
            {" "}
            — de {brl(origin?.totais.total ?? 0)} arrecadados no total
          </span>
        </div>
      </div>

      {contribuintes.length > 0 && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <h2 className="font-bold p-3">Consolidação por contribuinte</h2>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Contribuinte</th>
                <th className="p-3 font-semibold">Documento</th>
                <th className="p-3 font-semibold text-right">CDAs</th>
                <th className="p-3 font-semibold text-right">Inscrito</th>
                <th className="p-3 font-semibold text-right">Em cobrança</th>
              </tr>
            </thead>
            <tbody>
              {contribuintes.map((c) => (
                <tr
                  key={c.contribuinte_documento}
                  className="border-b last:border-0"
                >
                  <td className="p-3 font-medium">{c.contribuinte}</td>
                  <td className="p-3 tabular-nums">
                    {c.contribuinte_documento}
                  </td>
                  <td className="p-3 text-right tabular-nums">{c.qtd_cdas}</td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(c.total_inscrito)}
                  </td>
                  <td className="p-3 text-right tabular-nums font-medium">
                    {brl(c.total_ativa)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-x-auto">
        <h2 className="font-bold p-3">Certidões (CDA)</h2>
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Nº</th>
              <th className="p-3 font-semibold">Exercício</th>
              <th className="p-3 font-semibold">Inscrição</th>
              <th className="p-3 font-semibold text-right">Valor inscrito</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {cdas.map((c) => (
              <tr key={c.id} className="border-b last:border-0">
                <td className="p-3 font-medium tabular-nums">{c.numero}</td>
                <td className="p-3">{c.exercicio}</td>
                <td className="p-3">{c.data_inscricao}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(c.valor_inscrito)}
                </td>
                <td className="p-3">
                  <Badge
                    variant={c.status === "ativa" ? "destructive" : "secondary"}
                  >
                    {c.status}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    {c.status === "ativa" && (
                      <div className="flex gap-2 flex-wrap">
                        {!ajuizadas.has(c.numero) && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setTarget(c);
                              setProcesso("");
                            }}
                          >
                            <Gavel className="size-4" /> Ajuizar
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doSettle(c)}
                        >
                          <CheckCircle2 className="size-4" /> Quitar
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doCancel(c)}
                        >
                          <Ban className="size-4" /> Cancelar
                        </Button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {cdas.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 6 : 5}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhuma CDA emitida.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <h2 className="font-bold p-3">Execuções fiscais</h2>
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">CDA</th>
              <th className="p-3 font-semibold">Processo</th>
              <th className="p-3 font-semibold">Ajuizamento</th>
              <th className="p-3 font-semibold text-right">Valor</th>
              <th className="p-3 font-semibold">Andamento</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {executions.map((e) => (
              <tr key={e.id} className="border-b last:border-0">
                <td className="p-3 tabular-nums">{e.cda_numero}</td>
                <td className="p-3 font-medium">{e.numero_processo}</td>
                <td className="p-3">{e.data_ajuizamento}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(e.valor_ajuizado)}
                </td>
                <td className="p-3">
                  <Badge variant="secondary">{e.status}</Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    {e.status !== "extinta" && e.status !== "quitada" && (
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => changeStatus(e, "suspensa")}
                        >
                          Suspender
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => changeStatus(e, "quitada")}
                        >
                          Quitar
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => changeStatus(e, "extinta")}
                        >
                          Extinguir
                        </Button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {executions.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 6 : 5}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhuma execução ajuizada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog
        open={Boolean(target)}
        onOpenChange={(o) => !o && setTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Ajuizar execução — CDA nº {target?.numero}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Valor inscrito: {brl(target?.valor_inscrito ?? 0)}.
            </p>
            <div>
              <Label>Número do processo</Label>
              <Input
                value={processo}
                onChange={(e) => setProcesso(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitFile} disabled={busy || !processo.trim()}>
              Ajuizar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
