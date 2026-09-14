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
import {
  getContracts,
  saveContract,
  transitionContract,
  getContractsSummary,
  getExpiringContracts,
} from "@/lib/contracts.functions";
import {
  getContractMeasurements,
  getContractMeasurementsSummary,
  recordContractMeasurement,
  attestContractMeasurement,
  cancelContractMeasurement,
} from "@/lib/contract-measurements.functions";
import {
  getContractItems,
  addContractItem,
  cancelContractItem,
} from "@/lib/contract-items.functions";
import {
  getContractAmendments,
  registerContractAmendment,
  cancelContractAmendment,
} from "@/lib/contract-amendments.functions";
import { linkContractToProcurement } from "@/lib/contract-procurement.functions";
import { getProcurementProcesses } from "@/lib/procurement.functions";

import { AppShell } from "@/components/AppShell";

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
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
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
  const attest = useServerFn(attestContractMeasurement);
  const cancelMeasurement = useServerFn(cancelContractMeasurement);
  const transition = useServerFn(transitionContract);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // O3-07/08/09 — itens, aditivos e licitação de origem. Existiam no servidor
  // sem nenhuma tela: um contrato não tinha como ser detalhado, aditado nem
  // ligado ao processo que o originou.
  const loadItems = useServerFn(getContractItems);
  const doAddItem = useServerFn(addContractItem);
  const loadAmendments = useServerFn(getContractAmendments);
  const doAmend = useServerFn(registerContractAmendment);
  const doLinkProcess = useServerFn(linkContractToProcurement);
  const loadProcesses = useServerFn(getProcurementProcesses);
  const [detalhes, setDetalhes] = useState<Contract | null>(null);
  const [itemOpen, setItemOpen] = useState(false);
  const [itemForm, setItemForm] = useState({
    descricao: "",
    unidade: "un",
    quantidade: "",
    preco_unitario: "",
  });
  const [aditivoOpen, setAditivoOpen] = useState(false);
  const [aditivoForm, setAditivoForm] = useState({
    tipo: "valor",
    valor_acrescimo: "",
    nova_vigencia_fim: "",
    justificativa: "",
    data_aditivo: new Date().toISOString().slice(0, 10),
  });
  const [vinculoOpen, setVinculoOpen] = useState(false);
  const [processId, setProcessId] = useState("");
  // O3-14 — desfazer. Aditivo e item consomem cota legal (25% do art. 125 e o
  // valor do contrato): sem cancelamento, um lançamento errado a queimava para
  // sempre, e "registrar outro compensando" não resolve, porque o limite é
  // sobre o acumulado.
  const doCancelItem = useServerFn(cancelContractItem);
  const doCancelAditivo = useServerFn(cancelContractAmendment);
  const [cancelAlvo, setCancelAlvo] = useState<{
    tipo: "item" | "aditivo";
    id: string;
    rotulo: string;
  } | null>(null);
  const [cancelMotivo, setCancelMotivo] = useState("");
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

  const loadSummary = useServerFn(getContractsSummary);
  const { data: summary } = useQuery({
    queryKey: ["contracts-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadSummary({ data: { tenant_id: activeTenant!.id } }),
  });
  const loadExpiring = useServerFn(getExpiringContracts);
  const { data: expiring } = useQuery({
    queryKey: ["contracts-expiring", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadExpiring({
        data: {
          tenant_id: activeTenant!.id,
          data_referencia: new Date().toISOString().slice(0, 10),
          dias: 30,
        },
      }),
  });
  const expiringList = (expiring?.contracts ?? []) as Array<{
    id: string;
    numero: string;
    ano: number;
    fornecedor: string;
    vigencia_fim: string;
    dias_para_vencer: number;
  }>;

  const { data: itemsData } = useQuery({
    queryKey: ["contract-items", activeTenant?.id, detalhes?.id],
    enabled: Boolean(activeTenant && detalhes),
    queryFn: () =>
      loadItems({
        data: { tenant_id: activeTenant!.id, contract_id: detalhes!.id },
      }),
  });
  const { data: amendmentsData } = useQuery({
    queryKey: ["contract-amendments", activeTenant?.id, detalhes?.id],
    enabled: Boolean(activeTenant && detalhes),
    queryFn: () =>
      loadAmendments({
        data: { tenant_id: activeTenant!.id, contract_id: detalhes!.id },
      }),
  });
  const { data: processesData } = useQuery({
    queryKey: ["procurement-processes", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadProcesses({ data: { tenant_id: activeTenant!.id } }),
  });
  const contractItems = (itemsData?.items ?? []) as Array<{
    id: string;
    numero: number;
    descricao: string;
    unidade: string;
    quantidade: string;
    preco_unitario: string;
    valor_total: string;
    status: string;
    motivo_cancelamento: string | null;
  }>;
  const amendments = (amendmentsData?.amendments ?? []) as Array<{
    id: string;
    numero: number;
    tipo: string;
    valor_acrescimo: string;
    nova_vigencia_fim: string | null;
    justificativa: string;
    data_aditivo: string;
    status: string;
    motivo_cancelamento: string | null;
  }>;
  // Só uma licitação homologada da mesma modalidade pode originar o contrato —
  // filtrar aqui evita oferecer uma opção que o servidor vai recusar.
  const processosElegiveis = (
    (processesData?.processes ?? []) as Array<{
      id: string;
      numero: string;
      ano: number;
      modalidade: string;
      objeto: string;
      status: string;
    }>
  ).filter(
    (p) =>
      p.status === "homologada" &&
      p.modalidade === (detalhes?.modalidade ?? ""),
  );

  const refreshDetalhes = () => {
    qc.invalidateQueries({ queryKey: ["contracts", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["contracts-summary", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["contract-items", activeTenant?.id, detalhes?.id],
    });
    qc.invalidateQueries({
      queryKey: ["contract-amendments", activeTenant?.id, detalhes?.id],
    });
  };

  const submitCancelamento = async () => {
    if (!activeTenant || !cancelAlvo) return;
    setBusy(true);
    try {
      const motivo = cancelMotivo.trim();
      if (cancelAlvo.tipo === "item")
        await doCancelItem({
          data: {
            tenant_id: activeTenant.id,
            item_id: cancelAlvo.id,
            motivo,
          },
        });
      else {
        const r = await doCancelAditivo({
          data: {
            tenant_id: activeTenant.id,
            amendment_id: cancelAlvo.id,
            motivo,
          },
        });
        toast.success(
          `Aditivo cancelado — contrato volta a ${brl(r.valor_total)}`,
        );
      }
      if (cancelAlvo.tipo === "item") toast.success("Item cancelado");
      setCancelAlvo(null);
      setCancelMotivo("");
      refreshDetalhes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao cancelar");
    } finally {
      setBusy(false);
    }
  };

  const submitItem = async () => {
    if (!activeTenant || !detalhes) return;
    setBusy(true);
    try {
      const r = await doAddItem({
        data: {
          tenant_id: activeTenant.id,
          contract_id: detalhes.id,
          descricao: itemForm.descricao.trim(),
          unidade: itemForm.unidade.trim(),
          quantidade: Number(itemForm.quantidade),
          preco_unitario: Number(itemForm.preco_unitario),
        },
      });
      toast.success(`Item ${r.numero} incluído: ${brl(r.valor_total)}`);
      setItemOpen(false);
      setItemForm({
        descricao: "",
        unidade: "un",
        quantidade: "",
        preco_unitario: "",
      });
      refreshDetalhes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao incluir");
    } finally {
      setBusy(false);
    }
  };

  const submitAditivo = async () => {
    if (!activeTenant || !detalhes) return;
    setBusy(true);
    try {
      const tipo = aditivoForm.tipo as "valor" | "prazo" | "valor_prazo";
      const r = await doAmend({
        data: {
          tenant_id: activeTenant.id,
          contract_id: detalhes.id,
          tipo,
          valor_acrescimo:
            tipo === "prazo" ? 0 : Number(aditivoForm.valor_acrescimo),
          nova_vigencia_fim:
            tipo === "valor" ? null : aditivoForm.nova_vigencia_fim,
          justificativa: aditivoForm.justificativa.trim(),
          data_aditivo: aditivoForm.data_aditivo,
        },
      });
      toast.success(
        `Aditivo ${r.numero} registrado — contrato passa a ${brl(r.valor_total)}`,
      );
      setAditivoOpen(false);
      setAditivoForm((f) => ({
        ...f,
        valor_acrescimo: "",
        nova_vigencia_fim: "",
        justificativa: "",
      }));
      refreshDetalhes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao aditar");
    } finally {
      setBusy(false);
    }
  };

  const submitVinculo = async () => {
    if (!activeTenant || !detalhes || !processId) return;
    setBusy(true);
    try {
      await doLinkProcess({
        data: {
          tenant_id: activeTenant.id,
          contract_id: detalhes.id,
          process_id: processId,
        },
      });
      toast.success("Contrato vinculado à licitação de origem");
      setVinculoOpen(false);
      refreshDetalhes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao vincular");
    } finally {
      setBusy(false);
    }
  };

  const { data: measurements } = useQuery({
    queryKey: ["contract-measurements", activeTenant?.id, expanded],
    enabled: Boolean(activeTenant) && Boolean(expanded),
    queryFn: () =>
      loadMeasurements({
        data: { tenant_id: activeTenant!.id, contract_id: expanded! },
      }),
  });

  const loadMeasurementSummary = useServerFn(getContractMeasurementsSummary);
  const { data: measurementSummary } = useQuery({
    queryKey: ["contract-measurements-summary", activeTenant?.id, expanded],
    enabled: Boolean(activeTenant) && Boolean(expanded),
    queryFn: () =>
      loadMeasurementSummary({
        data: { tenant_id: activeTenant!.id, contract_id: expanded! },
      }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["contracts", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["contract-measurements", activeTenant?.id],
    });
    qc.invalidateQueries({
      queryKey: ["contract-measurements-summary", activeTenant?.id],
    });
    qc.invalidateQueries({ queryKey: ["contracts-summary", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["contracts-expiring", activeTenant?.id],
    });
  };

  const doTransition = async (
    c: Contract,
    acao: "suspender" | "retomar" | "encerrar" | "rescindir",
  ) => {
    if (!activeTenant) return;
    try {
      await transition({
        data: { tenant_id: activeTenant.id, contract_id: c.id, acao },
      });
      toast.success("Situação do contrato atualizada");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha na transição",
      );
    }
  };

  const doAttest = async (measurementId: string) => {
    if (!activeTenant) return;
    if (
      !window.confirm(
        "Receber a medição em definitivo? O atesto autoriza o pagamento e é irreversível.",
      )
    )
      return;
    try {
      await attest({
        data: { tenant_id: activeTenant.id, measurement_id: measurementId },
      });
      toast.success("Medição recebida em definitivo");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha no atesto");
    }
  };

  const doCancelMeasurement = async (measurementId: string) => {
    if (!activeTenant) return;
    if (
      !window.confirm(
        "Cancelar (glosar) esta medição provisória? O valor volta ao saldo executável do contrato.",
      )
    )
      return;
    try {
      await cancelMeasurement({
        data: { tenant_id: activeTenant.id, measurement_id: measurementId },
      });
      toast.success("Medição cancelada");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao cancelar");
    }
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

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Contratado (vigentes)
            </div>
            <div className="text-xl font-bold">
              {brl(summary.valorContratado)}
            </div>
            <div className="text-xs text-muted-foreground">
              {summary.porStatus.vigente} vigentes
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Empenhado</div>
            <div className="text-xl font-bold">
              {brl(summary.valorEmpenhado)}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Executado (medições)
            </div>
            <div className="text-xl font-bold">
              {brl(summary.valorExecutado)}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Saldo a executar
            </div>
            <div className="text-xl font-bold">
              {brl(summary.saldoAExecutar)}
            </div>
          </div>
        </div>
      )}

      {expiringList.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <h2 className="font-bold text-amber-700 dark:text-amber-500">
            Contratos a vencer em 30 dias ({expiringList.length})
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {expiringList.map((c) => (
              <li key={c.id} className="flex justify-between gap-3">
                <span>
                  <span className="font-medium tabular-nums">
                    {c.numero}/{c.ano}
                  </span>{" "}
                  — {c.fornecedor}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {c.vigencia_fim} ({c.dias_para_vencer}d)
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setDetalhes((d) => (d?.id === c.id ? null : c))
                      }
                    >
                      {detalhes?.id === c.id ? "Ocultar" : "Itens e aditivos"}
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
                    {canManage && c.status === "vigente" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => doTransition(c, "suspender")}
                      >
                        Suspender
                      </Button>
                    )}
                    {canManage && c.status === "suspenso" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => doTransition(c, "retomar")}
                      >
                        Retomar
                      </Button>
                    )}
                    {canManage &&
                      (c.status === "vigente" || c.status === "suspenso") && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => doTransition(c, "encerrar")}
                          >
                            Encerrar
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => doTransition(c, "rescindir")}
                          >
                            Rescindir
                          </Button>
                        </>
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

      {detalhes && (
        <div className="rounded-xl border bg-card">
          <div className="flex items-center justify-between gap-3 flex-wrap p-3">
            <h2 className="font-bold">
              Contrato {detalhes.numero}/{detalhes.ano} — itens, aditivos e
              origem
            </h2>
            {canManage && detalhes.status === "vigente" && (
              <div className="flex gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setItemOpen(true)}
                >
                  <Plus className="size-4" /> Item
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAditivoOpen(true)}
                >
                  <Plus className="size-4" /> Aditivo
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setProcessId(processosElegiveis[0]?.id ?? "");
                    setVinculoOpen(true);
                  }}
                  disabled={processosElegiveis.length === 0}
                >
                  Vincular licitação
                </Button>
              </div>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-2 p-3 pt-0">
            <div className="rounded-lg border overflow-x-auto">
              <div className="p-2 text-sm font-semibold border-b bg-muted/40">
                Itens ({contractItems.length}) — soma{" "}
                {brl(
                  contractItems
                    .filter((i) => i.status !== "cancelado")
                    .reduce((s, i) => s + Number(i.valor_total), 0),
                )}{" "}
                de {brl(detalhes.valor_total)}
              </div>
              <table className="w-full text-sm">
                <thead className="border-b text-left">
                  <tr>
                    <th className="p-2 font-semibold">#</th>
                    <th className="p-2 font-semibold">Descrição</th>
                    <th className="p-2 font-semibold text-right">Qtd</th>
                    <th className="p-2 font-semibold text-right">Unitário</th>
                    <th className="p-2 font-semibold text-right">Total</th>
                    <th className="p-2 font-semibold" />
                  </tr>
                </thead>
                <tbody>
                  {contractItems.map((i) => (
                    <tr
                      key={i.id}
                      className={`border-b last:border-0 ${i.status === "cancelado" ? "text-muted-foreground line-through" : ""}`}
                    >
                      <td className="p-2 tabular-nums">{i.numero}</td>
                      <td className="p-2">{i.descricao}</td>
                      <td className="p-2 text-right tabular-nums">
                        {Number(i.quantidade)} {i.unidade}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {brl(i.preco_unitario)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {brl(i.valor_total)}
                      </td>
                      <td className="p-2 no-underline">
                        {i.status === "cancelado" ? (
                          <Badge
                            variant="outline"
                            title={i.motivo_cancelamento ?? ""}
                          >
                            cancelado
                          </Badge>
                        ) : (
                          canManage &&
                          detalhes.status === "vigente" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setCancelMotivo("");
                                setCancelAlvo({
                                  tipo: "item",
                                  id: i.id,
                                  rotulo: `item ${i.numero} — ${i.descricao}`,
                                });
                              }}
                            >
                              Cancelar
                            </Button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                  {contractItems.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="p-4 text-center text-muted-foreground"
                      >
                        Contrato sem itens detalhados.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="rounded-lg border overflow-x-auto">
              <div className="p-2 text-sm font-semibold border-b bg-muted/40">
                Termos aditivos ({amendments.length}) — limite de 25% do valor
                original (Lei 14.133 art. 125)
              </div>
              <table className="w-full text-sm">
                <thead className="border-b text-left">
                  <tr>
                    <th className="p-2 font-semibold">#</th>
                    <th className="p-2 font-semibold">Tipo</th>
                    <th className="p-2 font-semibold text-right">Valor</th>
                    <th className="p-2 font-semibold">Nova vigência</th>
                    <th className="p-2 font-semibold">Data</th>
                    <th className="p-2 font-semibold" />
                  </tr>
                </thead>
                <tbody>
                  {amendments.map((a) => (
                    <tr
                      key={a.id}
                      className={`border-b last:border-0 ${a.status === "cancelado" ? "text-muted-foreground line-through" : ""}`}
                    >
                      <td className="p-2 tabular-nums">{a.numero}</td>
                      <td className="p-2">{a.tipo.replace("_", " + ")}</td>
                      <td className="p-2 text-right tabular-nums">
                        {Number(a.valor_acrescimo) === 0
                          ? "—"
                          : brl(a.valor_acrescimo)}
                      </td>
                      <td className="p-2 tabular-nums">
                        {a.nova_vigencia_fim ?? "—"}
                      </td>
                      <td className="p-2 tabular-nums">{a.data_aditivo}</td>
                      <td className="p-2 no-underline">
                        {a.status === "cancelado" ? (
                          <Badge
                            variant="outline"
                            title={a.motivo_cancelamento ?? ""}
                          >
                            cancelado
                          </Badge>
                        ) : (
                          canManage &&
                          detalhes.status === "vigente" &&
                          // Só o último vigente: cancelar um do meio deixaria os
                          // posteriores apoiados num estado que deixou de existir.
                          a.numero ===
                            Math.max(
                              ...amendments
                                .filter((x) => x.status !== "cancelado")
                                .map((x) => x.numero),
                            ) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setCancelMotivo("");
                                setCancelAlvo({
                                  tipo: "aditivo",
                                  id: a.id,
                                  rotulo: `termo aditivo ${a.numero}`,
                                });
                              }}
                            >
                              Cancelar
                            </Button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                  {amendments.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="p-4 text-center text-muted-foreground"
                      >
                        Nenhum termo aditivo.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {expanded && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <h2 className="font-bold p-3">Medições do contrato</h2>
          {measurementSummary && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 px-3 pb-3">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">
                  Saldo executável
                </div>
                <div className="text-lg font-bold tabular-nums">
                  {brl(measurementSummary.saldo_a_executar)}
                </div>
                <div className="text-xs text-muted-foreground">
                  de {brl(measurementSummary.valor_total)}
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">
                  Atestado (pode pagar)
                </div>
                <div className="text-lg font-bold tabular-nums text-emerald-600">
                  {brl(measurementSummary.medicoes.definitivo)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {measurementSummary.medicoes.q_definitivo} medição(ões)
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">
                  Aguardando atesto
                </div>
                <div className="text-lg font-bold tabular-nums">
                  {brl(measurementSummary.medicoes.provisorio)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {measurementSummary.medicoes.q_provisorio} medição(ões)
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Glosado</div>
                <div className="text-lg font-bold tabular-nums text-muted-foreground">
                  {brl(measurementSummary.medicoes.glosado)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {measurementSummary.medicoes.q_glosado} medição(ões)
                </div>
              </div>
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Nº</th>
                <th className="p-3 font-semibold">Competência</th>
                <th className="p-3 font-semibold">Descrição</th>
                <th className="p-3 font-semibold text-right">Valor</th>
                <th className="p-3 font-semibold">Recebimento</th>
                {measurements?.canManage && (
                  <th className="p-3 font-semibold">Ações</th>
                )}
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
                  {measurements?.canManage && (
                    <td className="p-3">
                      {m.recebimento === "provisorio" && (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => doAttest(m.id)}
                          >
                            Receber definitivo
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => doCancelMeasurement(m.id)}
                          >
                            Cancelar
                          </Button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {(measurements?.measurements ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={measurements?.canManage ? 6 : 5}
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

      <Dialog
        open={Boolean(cancelAlvo)}
        onOpenChange={(o) => !o && setCancelAlvo(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar {cancelAlvo?.rotulo}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              O registro não é apagado: fica na lista marcado como cancelado,
              com o motivo — em contrato público o que foi registrado e depois
              desfeito faz parte da instrução do processo. O que volta é a cota
              que ele ocupava.
            </p>
            <div>
              <Label>Motivo do cancelamento</Label>
              <Input
                value={cancelMotivo}
                onChange={(e) => setCancelMotivo(e.target.value)}
                placeholder="Ex.: valor digitado incorretamente"
              />
              {cancelMotivo.trim().length > 0 &&
                cancelMotivo.trim().length < 5 && (
                  <p className="mt-1 text-xs text-destructive">
                    Descreva o motivo com pelo menos 5 caracteres.
                  </p>
                )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={submitCancelamento}
              disabled={busy || cancelMotivo.trim().length < 5}
            >
              Confirmar cancelamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={itemOpen} onOpenChange={setItemOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo item do contrato</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Descrição</Label>
              <Input
                value={itemForm.descricao}
                onChange={(e) =>
                  setItemForm((f) => ({ ...f, descricao: e.target.value }))
                }
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Unidade</Label>
                <Input
                  value={itemForm.unidade}
                  onChange={(e) =>
                    setItemForm((f) => ({ ...f, unidade: e.target.value }))
                  }
                />
              </div>
              <div>
                <Label>Quantidade</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={itemForm.quantidade}
                  onChange={(e) =>
                    setItemForm((f) => ({ ...f, quantidade: e.target.value }))
                  }
                />
              </div>
              <div>
                <Label>Preço unitário</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={itemForm.preco_unitario}
                  onChange={(e) =>
                    setItemForm((f) => ({
                      ...f,
                      preco_unitario: e.target.value,
                    }))
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              A soma dos itens não pode exceder o valor total do contrato.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={submitItem}
              disabled={
                busy ||
                itemForm.descricao.trim().length < 2 ||
                !(Number(itemForm.quantidade) > 0) ||
                !(Number(itemForm.preco_unitario) > 0)
              }
            >
              Incluir item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={aditivoOpen} onOpenChange={setAditivoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Termo aditivo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Tipo</Label>
              <Select
                value={aditivoForm.tipo}
                onValueChange={(v) =>
                  setAditivoForm((f) => ({ ...f, tipo: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="valor">Valor</SelectItem>
                  <SelectItem value="prazo">Prazo</SelectItem>
                  <SelectItem value="valor_prazo">Valor e prazo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {aditivoForm.tipo !== "prazo" && (
              <div>
                <Label>Acréscimo (negativo = supressão)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={aditivoForm.valor_acrescimo}
                  onChange={(e) =>
                    setAditivoForm((f) => ({
                      ...f,
                      valor_acrescimo: e.target.value,
                    }))
                  }
                />
              </div>
            )}
            {aditivoForm.tipo !== "valor" && (
              <div>
                <Label>Nova vigência (fim)</Label>
                <Input
                  type="date"
                  value={aditivoForm.nova_vigencia_fim}
                  onChange={(e) =>
                    setAditivoForm((f) => ({
                      ...f,
                      nova_vigencia_fim: e.target.value,
                    }))
                  }
                />
              </div>
            )}
            <div>
              <Label>Data do aditivo</Label>
              <Input
                type="date"
                value={aditivoForm.data_aditivo}
                onChange={(e) =>
                  setAditivoForm((f) => ({
                    ...f,
                    data_aditivo: e.target.value,
                  }))
                }
              />
            </div>
            <div>
              <Label>Justificativa</Label>
              <Input
                value={aditivoForm.justificativa}
                onChange={(e) =>
                  setAditivoForm((f) => ({
                    ...f,
                    justificativa: e.target.value,
                  }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitAditivo}
              disabled={
                busy ||
                aditivoForm.justificativa.trim().length < 5 ||
                (aditivoForm.tipo !== "prazo" &&
                  !(Number(aditivoForm.valor_acrescimo) !== 0)) ||
                (aditivoForm.tipo !== "valor" && !aditivoForm.nova_vigencia_fim)
              }
            >
              Registrar aditivo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={vinculoOpen} onOpenChange={setVinculoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Licitação de origem</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Processo homologado</Label>
              <Select value={processId} onValueChange={setProcessId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  {processosElegiveis.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.numero}/{p.ano} — {p.objeto.slice(0, 50)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              Só uma licitação homologada e da mesma modalidade do contrato pode
              originá-lo (Lei 14.133).
            </p>
          </div>
          <DialogFooter>
            <Button onClick={submitVinculo} disabled={busy || !processId}>
              Vincular
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
