import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Landmark,
  Home,
  HandCoins,
  FileWarning,
  Briefcase,
  ArrowLeftRight,
  Calculator,
  ScrollText,
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
  getTaxCredits,
  recordTaxPayment,
  inscribeDividaAtiva,
  getUpdatedTaxDebt,
  cancelTaxCredit,
  launchTaxCredit,
  getTaxCreditsSummary,
  getTaxCreditsByTributo,
  getTaxCreditPayments,
} from "@/lib/taxes.functions";
import { emitActiveDebtCertificate } from "@/lib/active-debt-certificate.functions";
import {
  getProperties,
  launchIptu,
  launchIptuBatch,
  getRealEstateSummary,
  setPropertyTaxBenefit,
} from "@/lib/real-estate.functions";
import {
  getServiceTaxpayers,
  launchIss,
  saveServiceTaxpayer,
} from "@/lib/service-tax.functions";
import { checkTaxClearance } from "@/lib/tax-clearance.functions";
import { launchItbi } from "@/lib/itbi.functions";

import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/tributos")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("taxes.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

type Credit = {
  id: string;
  tributo: string;
  exercicio: number;
  contribuinte: string;
  inscricao: string;
  valor_lancado: string;
  valor_pago: string;
  saldo: string;
  vencimento: string;
  status: string;
};
type Property = {
  id: string;
  inscricao_imobiliaria: string;
  proprietario: string;
  valor_venal: string;
  status: string;
  beneficio_iptu: string | null;
};
type Taxpayer = {
  id: string;
  inscricao_municipal: string;
  razao_social: string;
  aliquota_iss: string;
  status: string;
};
type Clearance = {
  contribuinte_documento: string;
  situacao: string;
  saldo_total: number;
  saldo_suspenso: number;
  saldo_a_vencer: number;
  saldo_exigivel: number;
  em_divida_ativa: boolean;
  debts: Array<{
    id: string;
    tributo: string;
    exercicio: number;
    inscricao: string;
    saldo: string;
    status: string;
    vencimento: string;
    suspenso: boolean;
    vencido: boolean;
  }>;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);
const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  lancado: "secondary",
  divida_ativa: "destructive",
  quitado: "default",
  cancelado: "outline",
};

function Content() {
  const { activeTenant } = useAuth();
  const loadCredits = useServerFn(getTaxCredits);
  const loadProps = useServerFn(getProperties);
  const loadTaxpayers = useServerFn(getServiceTaxpayers);
  const pay = useServerFn(recordTaxPayment);
  const inscribe = useServerFn(inscribeDividaAtiva);
  const updatedDebt = useServerFn(getUpdatedTaxDebt);
  const emitCda = useServerFn(emitActiveDebtCertificate);
  const cancelCredit = useServerFn(cancelTaxCredit);
  const launch = useServerFn(launchIptu);
  const launchLote = useServerFn(launchIptuBatch);
  const doLaunchIss = useServerFn(launchIss);
  const doLaunchItbi = useServerFn(launchItbi);
  const qc = useQueryClient();

  const [payOpen, setPayOpen] = useState(false);
  const [payCredit, setPayCredit] = useState<Credit | null>(null);
  const [payValor, setPayValor] = useState("");

  const [iptuOpen, setIptuOpen] = useState(false);
  const [iptuLote, setIptuLote] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [exercicio, setExercicio] = useState(String(new Date().getFullYear()));
  const [aliquota, setAliquota] = useState("1");
  const [vencimento, setVencimento] = useState(hoje());

  const [issOpen, setIssOpen] = useState(false);
  const [issTaxpayerId, setIssTaxpayerId] = useState("");
  const [competencia, setCompetencia] = useState(hoje().slice(0, 7));
  const [baseIss, setBaseIss] = useState("");

  const [itbiOpen, setItbiOpen] = useState(false);
  const [itbiPropertyId, setItbiPropertyId] = useState("");
  const [adquirente, setAdquirente] = useState("");
  const [adquirenteDoc, setAdquirenteDoc] = useState("");
  const [valorTransmissao, setValorTransmissao] = useState("");
  const [aliquotaItbi, setAliquotaItbi] = useState("2");

  // O4-04c — imunidade/isenção de IPTU do imóvel.
  const doSetBenefit = useServerFn(setPropertyTaxBenefit);
  const [benefitOpen, setBenefitOpen] = useState(false);
  const [benefitPropertyId, setBenefitPropertyId] = useState("");
  const [beneficio, setBeneficio] = useState("imunidade");
  const [beneficioMotivo, setBeneficioMotivo] = useState("");

  // Lançamento avulso (TAXA/COSIP e acertos manuais): é o único caminho para os
  // tributos que não nascem de imóvel nem de prestador de serviço.
  const doLaunchAvulso = useServerFn(launchTaxCredit);
  const [avulsoOpen, setAvulsoOpen] = useState(false);
  const [avTributo, setAvTributo] = useState("TAXA");
  const [avContribuinte, setAvContribuinte] = useState("");
  const [avDocumento, setAvDocumento] = useState("");
  const [avInscricao, setAvInscricao] = useState("");
  const [avValor, setAvValor] = useState("");

  // Cadastro do contribuinte de ISS: sem ele a lista de prestadores nasce vazia
  // e "Lançar ISS" fica permanentemente desabilitado.
  const doSaveTaxpayer = useServerFn(saveServiceTaxpayer);
  const [taxpayerOpen, setTaxpayerOpen] = useState(false);
  const [tpInscricao, setTpInscricao] = useState("");
  const [tpRazao, setTpRazao] = useState("");
  const [tpDocumento, setTpDocumento] = useState("");
  const [tpAtividade, setTpAtividade] = useState("");
  const [tpAliquota, setTpAliquota] = useState("2");

  // Consulta de regularidade fiscal (base da CND/CPEN).
  const doCheckClearance = useServerFn(checkTaxClearance);
  const [cndOpen, setCndOpen] = useState(false);
  const [cndDoc, setCndDoc] = useState("");
  const [cndResultado, setCndResultado] = useState<Clearance | null>(null);

  const [busy, setBusy] = useState(false);

  const [extratoCredit, setExtratoCredit] = useState<Credit | null>(null);
  const loadPayments = useServerFn(getTaxCreditPayments);
  const { data: extrato } = useQuery({
    queryKey: ["tax-payments", activeTenant?.id, extratoCredit?.id],
    enabled: Boolean(activeTenant && extratoCredit),
    queryFn: () =>
      loadPayments({
        data: { tenant_id: activeTenant!.id, credit_id: extratoCredit!.id },
      }),
  });

  const { data } = useQuery({
    queryKey: ["tax-credits", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadCredits({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: propsData } = useQuery({
    queryKey: ["properties", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadProps({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: taxpayersData } = useQuery({
    queryKey: ["service-taxpayers", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadTaxpayers({ data: { tenant_id: activeTenant!.id } }),
  });

  const credits = (data?.credits ?? []) as Credit[];
  const canManage = data?.canManage ?? false;
  const properties = (propsData?.properties ?? []) as Property[];
  const taxpayers = (taxpayersData?.taxpayers ?? []) as Taxpayer[];

  const loadSummary = useServerFn(getTaxCreditsSummary);
  const { data: summary } = useQuery({
    queryKey: ["tax-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadSummary({ data: { tenant_id: activeTenant!.id } }),
  });
  const loadByTributo = useServerFn(getTaxCreditsByTributo);
  const { data: byTributo } = useQuery({
    queryKey: ["tax-by-tributo", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadByTributo({ data: { tenant_id: activeTenant!.id } }),
  });
  const loadRealEstate = useServerFn(getRealEstateSummary);
  const { data: realEstate } = useQuery({
    queryKey: ["real-estate-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadRealEstate({ data: { tenant_id: activeTenant!.id } }),
  });
  const tributos = (byTributo?.tributos ?? []) as Array<{
    tributo: string;
    quantidade: number;
    lancado: number;
    arrecadado: number;
  }>;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tax-credits", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["tax-summary", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["tax-by-tributo", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["properties", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["real-estate-summary", activeTenant?.id],
    });
  };

  const openPay = (c: Credit) => {
    setPayCredit(c);
    setPayValor(c.saldo);
    setPayOpen(true);
  };

  const submitPay = async () => {
    if (!activeTenant || !payCredit) return;
    setBusy(true);
    try {
      await pay({
        data: {
          tenant_id: activeTenant.id,
          credit_id: payCredit.id,
          data_pagamento: hoje(),
          valor: Number(payValor),
        },
      });
      toast.success("Arrecadação registrada");
      setPayOpen(false);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao arrecadar",
      );
    } finally {
      setBusy(false);
    }
  };

  const doInscribe = async (c: Credit) => {
    if (!activeTenant) return;
    try {
      await inscribe({
        data: {
          tenant_id: activeTenant.id,
          credit_id: c.id,
          data_referencia: hoje(),
        },
      });
      toast.success("Inscrito em dívida ativa");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao inscrever",
      );
    }
  };

  const doCancelCredit = async (c: Credit) => {
    if (!activeTenant) return;
    try {
      await cancelCredit({
        data: {
          tenant_id: activeTenant.id,
          credit_id: c.id,
          motivo: "Isenção / anistia / remissão",
          data_cancelamento: hoje(),
        },
      });
      toast.success("Crédito cancelado");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao cancelar");
    }
  };

  const doEmitCda = async (c: Credit) => {
    if (!activeTenant) return;
    try {
      const r = await emitCda({
        data: {
          tenant_id: activeTenant.id,
          credit_id: c.id,
          data_inscricao: hoje(),
        },
      });
      toast.success(`CDA nº ${r.numero} emitida — ${brl(r.valor_inscrito)}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao emitir CDA",
      );
    }
  };

  const doUpdatedDebt = async (c: Credit) => {
    if (!activeTenant) return;
    try {
      const r = await updatedDebt({
        data: {
          tenant_id: activeTenant.id,
          credit_id: c.id,
          data_referencia: hoje(),
        },
      });
      toast.success(
        `Atualizado: ${brl(r.valor_atualizado)} (saldo ${brl(r.saldo)} + multa ${brl(
          r.multa,
        )} + juros ${brl(r.juros)}, ${r.meses_mora} mês(es) de mora)`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao atualizar",
      );
    }
  };

  const submitIptu = async () => {
    if (!activeTenant) return;
    if (!iptuLote && !propertyId) return;
    setBusy(true);
    try {
      if (iptuLote) {
        const r = await launchLote({
          data: {
            tenant_id: activeTenant.id,
            exercicio: Number(exercicio),
            aliquota: Number(aliquota),
            vencimento,
          },
        });
        toast.success(
          `IPTU do exercício lançado: ${r.lancados} imóvel(is), total ${brl(
            r.total_valor,
          )}${r.ignorados ? ` (${r.ignorados} ignorado(s))` : ""}${
            r.isentos ? ` · ${r.isentos} imune(s)/isento(s) fora do lote` : ""
          }`,
        );
      } else {
        const r = await launch({
          data: {
            tenant_id: activeTenant.id,
            property_id: propertyId,
            exercicio: Number(exercicio),
            aliquota: Number(aliquota),
            vencimento,
          },
        });
        toast.success(`IPTU lançado: ${brl(r.valor)}`);
      }
      setIptuOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao lançar");
    } finally {
      setBusy(false);
    }
  };

  const submitIss = async () => {
    if (!activeTenant || !issTaxpayerId) return;
    setBusy(true);
    try {
      const r = await doLaunchIss({
        data: {
          tenant_id: activeTenant.id,
          taxpayer_id: issTaxpayerId,
          competencia,
          base_calculo: Number(baseIss),
          vencimento: hoje(),
        },
      });
      toast.success(`ISS lançado: ${brl(r.valor)}`);
      setIssOpen(false);
      setBaseIss("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao lançar");
    } finally {
      setBusy(false);
    }
  };

  const submitBenefit = async (encerrar: boolean) => {
    if (!activeTenant || !benefitPropertyId) return;
    setBusy(true);
    try {
      await doSetBenefit({
        data: {
          tenant_id: activeTenant.id,
          property_id: benefitPropertyId,
          beneficio: encerrar ? null : (beneficio as "imunidade" | "isencao"),
          motivo: beneficioMotivo.trim(),
        },
      });
      toast.success(
        encerrar
          ? "Benefício encerrado: o imóvel volta a lançar IPTU"
          : `${beneficio === "imunidade" ? "Imunidade" : "Isenção"} de IPTU concedida`,
      );
      setBenefitOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao gravar");
    } finally {
      setBusy(false);
    }
  };

  const submitItbi = async () => {
    if (!activeTenant || !itbiPropertyId) return;
    setBusy(true);
    try {
      const r = await doLaunchItbi({
        data: {
          tenant_id: activeTenant.id,
          property_id: itbiPropertyId,
          adquirente: adquirente.trim(),
          adquirente_documento: adquirenteDoc.trim(),
          valor_transmissao: Number(valorTransmissao),
          aliquota: Number(aliquotaItbi),
          data_transmissao: hoje(),
          vencimento: hoje(),
        },
      });
      // O4-06b: avisa quando a base foi arbitrada pelo valor venal (CTN art. 148).
      toast.success(
        r.arbitrado
          ? `ITBI lançado: ${brl(r.valor)} — base arbitrada pelo valor venal (${brl(r.base_calculo)})`
          : `ITBI lançado: ${brl(r.valor)}`,
      );
      setItbiOpen(false);
      setValorTransmissao("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao lançar");
    } finally {
      setBusy(false);
    }
  };

  const submitAvulso = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await doLaunchAvulso({
        data: {
          tenant_id: activeTenant.id,
          tributo: avTributo as "IPTU" | "ISS" | "ITBI" | "TAXA" | "COSIP",
          exercicio: Number(exercicio),
          contribuinte: avContribuinte.trim(),
          contribuinte_documento: avDocumento.trim(),
          inscricao: avInscricao.trim(),
          valor_lancado: Number(avValor),
          vencimento,
        },
      });
      toast.success(`${avTributo} lançado: ${brl(avValor)}`);
      setAvulsoOpen(false);
      setAvContribuinte("");
      setAvDocumento("");
      setAvInscricao("");
      setAvValor("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao lançar");
    } finally {
      setBusy(false);
    }
  };

  const submitTaxpayer = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await doSaveTaxpayer({
        data: {
          tenant_id: activeTenant.id,
          inscricao_municipal: tpInscricao.trim(),
          razao_social: tpRazao.trim(),
          documento: tpDocumento.trim(),
          atividade: tpAtividade.trim(),
          aliquota_iss: Number(tpAliquota),
          status: "ativo" as const,
        },
      });
      toast.success("Contribuinte de ISS cadastrado");
      setTaxpayerOpen(false);
      setTpInscricao("");
      setTpRazao("");
      setTpDocumento("");
      setTpAtividade("");
      qc.invalidateQueries({
        queryKey: ["service-taxpayers", activeTenant.id],
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao gravar");
    } finally {
      setBusy(false);
    }
  };

  const submitCnd = async () => {
    if (!activeTenant || cndDoc.trim().length < 3) return;
    setBusy(true);
    try {
      const r = await doCheckClearance({
        data: {
          tenant_id: activeTenant.id,
          contribuinte_documento: cndDoc.trim(),
        },
      });
      setCndResultado(r as Clearance);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha na consulta");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Landmark className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Tributos</h1>
            <p className="text-sm text-muted-foreground">
              Créditos tributários, arrecadação e dívida ativa
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => {
              setCndResultado(null);
              setCndDoc("");
              setCndOpen(true);
            }}
          >
            <ScrollText className="size-4" /> Regularidade fiscal
          </Button>
        </div>
        {canManage && (
          <div className="flex gap-2 flex-wrap">
            <Button
              onClick={() => {
                setAvContribuinte("");
                setAvDocumento("");
                setAvInscricao("");
                setAvValor("");
                setAvulsoOpen(true);
              }}
            >
              <Calculator className="size-4" /> Novo lançamento
            </Button>
            <Button variant="outline" onClick={() => setTaxpayerOpen(true)}>
              <Briefcase className="size-4" /> Novo contribuinte ISS
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setIptuLote(false);
                setPropertyId(properties[0]?.id ?? "");
                setIptuOpen(true);
              }}
              disabled={properties.length === 0}
            >
              <Home className="size-4" /> Lançar IPTU
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setIptuLote(true);
                setIptuOpen(true);
              }}
              disabled={properties.length === 0}
            >
              <Home className="size-4" /> IPTU do exercício (lote)
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setIssTaxpayerId(taxpayers[0]?.id ?? "");
                setIssOpen(true);
              }}
              disabled={taxpayers.length === 0}
            >
              <Briefcase className="size-4" /> Lançar ISS
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setItbiPropertyId(properties[0]?.id ?? "");
                setItbiOpen(true);
              }}
              disabled={properties.length === 0}
            >
              <ArrowLeftRight className="size-4" /> Lançar ITBI
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setBenefitPropertyId(properties[0]?.id ?? "");
                setBeneficio(properties[0]?.beneficio_iptu ?? "imunidade");
                setBeneficioMotivo("");
                setBenefitOpen(true);
              }}
              disabled={properties.length === 0}
            >
              <Home className="size-4" /> Imunidade/isenção
            </Button>
          </div>
        )}
      </div>

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Lançado</div>
            <div className="text-xl font-bold">{brl(summary.valorLancado)}</div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Arrecadado</div>
            <div className="text-xl font-bold">{brl(summary.arrecadado)}</div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">A receber</div>
            <div className="text-xl font-bold">{brl(summary.aReceber)}</div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Em dívida ativa</div>
            <div className="text-xl font-bold">
              {summary.porStatus.divida_ativa}
            </div>
          </div>
        </div>
      )}

      {realEstate && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Base tributável do IPTU (valor venal)
            </div>
            <div className="text-xl font-bold">
              {brl(realEstate.valorVenalTributavel)}
            </div>
            <div className="text-xs text-muted-foreground">
              {realEstate.ativos} imóveis ativos · {realEstate.baixados}{" "}
              baixados
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Área construída cadastrada
            </div>
            <div className="text-xl font-bold">
              {realEstate.areaConstruidaTotal.toLocaleString("pt-BR")} m²
            </div>
          </div>
        </div>
      )}

      {tributos.length > 0 && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <h2 className="font-bold p-3">Arrecadação por tributo</h2>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Tributo</th>
                <th className="p-3 font-semibold text-right">Créditos</th>
                <th className="p-3 font-semibold text-right">Lançado</th>
                <th className="p-3 font-semibold text-right">Arrecadado</th>
              </tr>
            </thead>
            <tbody>
              {tributos.map((t) => (
                <tr key={t.tributo} className="border-b last:border-0">
                  <td className="p-3 font-medium">{t.tributo}</td>
                  <td className="p-3 text-right tabular-nums">
                    {t.quantidade}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(t.lancado)}
                  </td>
                  <td className="p-3 text-right tabular-nums font-medium">
                    {brl(t.arrecadado)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Tributo</th>
              <th className="p-3 font-semibold">Exerc.</th>
              <th className="p-3 font-semibold">Contribuinte</th>
              <th className="p-3 font-semibold">Inscrição</th>
              <th className="p-3 font-semibold text-right">Saldo</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {credits.map((c) => (
              <tr key={c.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{c.tributo}</td>
                <td className="p-3">{c.exercicio}</td>
                <td className="p-3">{c.contribuinte}</td>
                <td className="p-3 text-muted-foreground">{c.inscricao}</td>
                <td className="p-3 text-right tabular-nums">{brl(c.saldo)}</td>
                <td className="p-3">
                  <Badge variant={statusVariant[c.status] ?? "secondary"}>
                    {c.status.replace("_", " ")}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    <div className="flex gap-2">
                      {c.status !== "quitado" && c.status !== "cancelado" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openPay(c)}
                        >
                          <HandCoins className="size-4" /> Arrecadar
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setExtratoCredit(c)}
                      >
                        <ScrollText className="size-4" /> Extrato
                      </Button>
                      {c.status === "lancado" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doInscribe(c)}
                        >
                          <FileWarning className="size-4" /> Dívida ativa
                        </Button>
                      )}
                      {c.status !== "quitado" && c.status !== "cancelado" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doUpdatedDebt(c)}
                        >
                          <Calculator className="size-4" /> Atualizar
                        </Button>
                      )}
                      {c.status === "divida_ativa" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doEmitCda(c)}
                        >
                          <FileWarning className="size-4" /> Emitir CDA
                        </Button>
                      )}
                      {c.status !== "quitado" && c.status !== "cancelado" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doCancelCredit(c)}
                        >
                          <ArrowLeftRight className="size-4" /> Cancelar
                        </Button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {credits.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 7 : 6}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum crédito tributário lançado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Arrecadar */}
      <Dialog
        open={Boolean(extratoCredit)}
        onOpenChange={(o) => !o && setExtratoCredit(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Extrato de pagamentos — {extratoCredit?.tributo}{" "}
              {extratoCredit?.exercicio} ({extratoCredit?.inscricao})
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th className="p-2">Data</th>
                  <th className="p-2 text-right">Valor</th>
                  <th className="p-2 text-right">Saldo após</th>
                </tr>
              </thead>
              <tbody>
                {(extrato?.pagamentos ?? []).map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="p-2 tabular-nums">{p.data_pagamento}</td>
                    <td className="p-2 text-right tabular-nums">
                      {brl(p.valor)}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {brl(p.saldo_apos)}
                    </td>
                  </tr>
                ))}
                {(extrato?.pagamentos ?? []).length === 0 && (
                  <tr>
                    <td className="p-3 text-muted-foreground" colSpan={3}>
                      Nenhum pagamento registrado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {extrato && (
            <p className="text-sm font-semibold">
              Lançado {brl(extrato.valor_lancado)} · pago{" "}
              {brl(extrato.total_pago)} · saldo {brl(extrato.saldo)}
            </p>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Arrecadar tributo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {payCredit?.tributo} {payCredit?.exercicio} — saldo{" "}
              {payCredit ? brl(payCredit.saldo) : ""}
            </p>
            <div>
              <Label>Valor</Label>
              <Input
                type="number"
                step="0.01"
                value={payValor}
                onChange={(e) => setPayValor(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitPay} disabled={busy}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lançar IPTU */}
      <Dialog open={iptuOpen} onOpenChange={setIptuOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {iptuLote ? "Lançar IPTU do exercício (lote)" : "Lançar IPTU"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {iptuLote ? (
              <p className="text-sm text-muted-foreground">
                Gera o IPTU de todos os imóveis ativos sem lançamento no
                exercício (valor venal × alíquota). Imóveis já lançados são
                mantidos.
              </p>
            ) : (
              <div>
                <Label>Imóvel</Label>
                <Select value={propertyId} onValueChange={setPropertyId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {properties.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.inscricao_imobiliaria} — {p.proprietario} (
                        {brl(p.valor_venal)})
                        {p.beneficio_iptu ? ` — ${p.beneficio_iptu}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Exercício</Label>
                <Input
                  type="number"
                  value={exercicio}
                  onChange={(e) => setExercicio(e.target.value)}
                />
              </div>
              <div>
                <Label>Alíquota (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={aliquota}
                  onChange={(e) => setAliquota(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>Vencimento</Label>
              <Input
                type="date"
                value={vencimento}
                onChange={(e) => setVencimento(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitIptu} disabled={busy}>
              Lançar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lançar ISS */}
      <Dialog open={issOpen} onOpenChange={setIssOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lançar ISS</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Prestador</Label>
              <Select value={issTaxpayerId} onValueChange={setIssTaxpayerId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {taxpayers.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.inscricao_municipal} — {t.razao_social} (
                      {t.aliquota_iss}
                      %)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Competência</Label>
                <Input
                  type="month"
                  value={competencia}
                  onChange={(e) => setCompetencia(e.target.value)}
                />
              </div>
              <div>
                <Label>Base de cálculo</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={baseIss}
                  onChange={(e) => setBaseIss(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitIss} disabled={busy}>
              Lançar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lançar ITBI */}
      {/* Imunidade/isenção de IPTU (O4-04c, CF art. 150, VI) */}
      <Dialog open={benefitOpen} onOpenChange={setBenefitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Imunidade / isenção de IPTU</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Imóvel imune (CF art. 150, VI) ou isento (lei municipal) não
              recebe lançamento de IPTU — avulso nem em lote. Conceder exige o
              fundamento legal.
            </p>
            <div>
              <Label>Imóvel</Label>
              <Select
                value={benefitPropertyId}
                onValueChange={(v) => {
                  setBenefitPropertyId(v);
                  const p = properties.find((x) => x.id === v);
                  setBeneficio(p?.beneficio_iptu ?? "imunidade");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {properties.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.inscricao_imobiliaria} — {p.proprietario}
                      {p.beneficio_iptu ? ` — ${p.beneficio_iptu}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Benefício</Label>
              <Select value={beneficio} onValueChange={setBeneficio}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="imunidade">
                    Imunidade (CF art. 150, VI)
                  </SelectItem>
                  <SelectItem value="isencao">
                    Isenção (lei municipal)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Fundamento legal</Label>
              <Input
                value={beneficioMotivo}
                placeholder="Ex.: CF art. 150, VI, b — templo de qualquer culto"
                onChange={(e) => setBeneficioMotivo(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            {properties.find((x) => x.id === benefitPropertyId)
              ?.beneficio_iptu && (
              <Button
                variant="outline"
                onClick={() => submitBenefit(true)}
                disabled={busy}
              >
                Encerrar benefício
              </Button>
            )}
            <Button
              onClick={() => submitBenefit(false)}
              disabled={busy || beneficioMotivo.trim().length < 3}
            >
              Conceder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={avulsoOpen} onOpenChange={setAvulsoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo lançamento tributário</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Tributo</Label>
              <Select value={avTributo} onValueChange={setAvTributo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="TAXA">Taxa</SelectItem>
                  <SelectItem value="COSIP">COSIP</SelectItem>
                  <SelectItem value="IPTU">IPTU</SelectItem>
                  <SelectItem value="ISS">ISS</SelectItem>
                  <SelectItem value="ITBI">ITBI</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Exercício</Label>
                <Input
                  type="number"
                  value={exercicio}
                  onChange={(e) => setExercicio(e.target.value)}
                />
              </div>
              <div>
                <Label>Vencimento</Label>
                <Input
                  type="date"
                  value={vencimento}
                  onChange={(e) => setVencimento(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>Contribuinte</Label>
              <Input
                value={avContribuinte}
                onChange={(e) => setAvContribuinte(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>CPF/CNPJ</Label>
                <Input
                  value={avDocumento}
                  onChange={(e) => setAvDocumento(e.target.value)}
                />
              </div>
              <div>
                <Label>Inscrição</Label>
                <Input
                  value={avInscricao}
                  onChange={(e) => setAvInscricao(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>Valor lançado</Label>
              <Input
                type="number"
                step="0.01"
                value={avValor}
                onChange={(e) => setAvValor(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitAvulso}
              disabled={
                busy ||
                avContribuinte.trim().length < 2 ||
                avDocumento.trim().length < 3 ||
                avInscricao.trim().length < 1 ||
                !(Number(avValor) > 0)
              }
            >
              Lançar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={taxpayerOpen} onOpenChange={setTaxpayerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo contribuinte de ISS</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Inscrição municipal</Label>
                <Input
                  value={tpInscricao}
                  onChange={(e) => setTpInscricao(e.target.value)}
                />
              </div>
              <div>
                <Label>CPF/CNPJ</Label>
                <Input
                  value={tpDocumento}
                  onChange={(e) => setTpDocumento(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>Razão social</Label>
              <Input
                value={tpRazao}
                onChange={(e) => setTpRazao(e.target.value)}
              />
            </div>
            <div>
              <Label>Atividade</Label>
              <Input
                value={tpAtividade}
                onChange={(e) => setTpAtividade(e.target.value)}
              />
            </div>
            <div>
              <Label>Alíquota de ISS (%)</Label>
              <Input
                type="number"
                step="0.01"
                value={tpAliquota}
                onChange={(e) => setTpAliquota(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Teto de 5% (CF art. 156, §3º, I).
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitTaxpayer}
              disabled={
                busy ||
                tpInscricao.trim().length < 1 ||
                tpRazao.trim().length < 2 ||
                tpDocumento.trim().length < 3 ||
                tpAtividade.trim().length < 2 ||
                !(Number(tpAliquota) > 0)
              }
            >
              Cadastrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cndOpen} onOpenChange={setCndOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regularidade fiscal do contribuinte</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>CPF/CNPJ</Label>
              <div className="flex gap-2">
                <Input
                  value={cndDoc}
                  onChange={(e) => setCndDoc(e.target.value)}
                  placeholder="com ou sem máscara"
                />
                <Button
                  onClick={submitCnd}
                  disabled={busy || cndDoc.trim().length < 3}
                >
                  Consultar
                </Button>
              </div>
            </div>
            {cndResultado && (
              <div className="space-y-3">
                <Badge
                  variant={
                    cndResultado.situacao === "regular"
                      ? "default"
                      : cndResultado.situacao === "regular_com_ressalva"
                        ? "secondary"
                        : "destructive"
                  }
                >
                  {cndResultado.situacao === "regular"
                    ? "Regular — sem débito exigível"
                    : cndResultado.situacao === "regular_com_ressalva"
                      ? "Regular com ressalva (efeito de negativa)"
                      : "Com débitos exigíveis"}
                </Badge>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    Exigível hoje:{" "}
                    <strong>{brl(cndResultado.saldo_exigivel)}</strong>
                  </div>
                  <div>
                    A vencer:{" "}
                    <strong>{brl(cndResultado.saldo_a_vencer)}</strong>
                  </div>
                  <div>
                    Suspenso (parcelado):{" "}
                    <strong>{brl(cndResultado.saldo_suspenso)}</strong>
                  </div>
                  <div>
                    Total em aberto:{" "}
                    <strong>{brl(cndResultado.saldo_total)}</strong>
                  </div>
                </div>
                {cndResultado.debts.length > 0 && (
                  <div className="rounded-lg border max-h-64 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b bg-muted/40 text-left">
                        <tr>
                          <th className="p-2 font-semibold">Tributo</th>
                          <th className="p-2 font-semibold">Inscrição</th>
                          <th className="p-2 font-semibold text-right">
                            Saldo
                          </th>
                          <th className="p-2 font-semibold">Situação</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cndResultado.debts.map((d) => (
                          <tr key={d.id} className="border-b last:border-0">
                            <td className="p-2">
                              {d.tributo}/{d.exercicio}
                            </td>
                            <td className="p-2">{d.inscricao}</td>
                            <td className="p-2 text-right tabular-nums">
                              {brl(d.saldo)}
                            </td>
                            <td className="p-2 text-xs">
                              {d.suspenso
                                ? "suspenso (parcelado)"
                                : !d.vencido
                                  ? "a vencer"
                                  : d.status === "divida_ativa"
                                    ? "dívida ativa"
                                    : "vencido"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Consulta interna de regularidade. Não é a certidão: a CND/CPEN
                  exige layout, código de autenticação e assinatura do ente.
                </p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={itbiOpen} onOpenChange={setItbiOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lançar ITBI</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Imóvel</Label>
              <Select value={itbiPropertyId} onValueChange={setItbiPropertyId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {properties.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.inscricao_imobiliaria} — {p.proprietario}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Adquirente</Label>
                <Input
                  value={adquirente}
                  onChange={(e) => setAdquirente(e.target.value)}
                />
              </div>
              <div>
                <Label>Documento</Label>
                <Input
                  value={adquirenteDoc}
                  onChange={(e) => setAdquirenteDoc(e.target.value)}
                />
              </div>
              <div>
                <Label>Valor da transmissão</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={valorTransmissao}
                  onChange={(e) => setValorTransmissao(e.target.value)}
                />
              </div>
              <div>
                <Label>Alíquota (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={aliquotaItbi}
                  onChange={(e) => setAliquotaItbi(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitItbi} disabled={busy}>
              Lançar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
