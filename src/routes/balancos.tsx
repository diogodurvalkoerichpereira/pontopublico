import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BarChart3 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { getBudgetBalance } from "@/lib/budget-balance.functions";
import { getCashAvailability } from "@/lib/cash-availability.functions";
import { getEquityStatement } from "@/lib/equity-statement.functions";
import { getFinancialBalance } from "@/lib/financial-balance.functions";
import { getCashFlowStatement } from "@/lib/cash-flow-statement.functions";
import { getTaxRevenueByOrigin } from "@/lib/taxes.functions";

import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/balancos")({ component: Page });

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

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between py-2 border-b last:border-0 ${
        strong ? "font-bold" : ""
      }`}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{brl(value)}</span>
    </div>
  );
}

function Content() {
  const { activeTenant, hasTenantPermission } = useAuth();
  const loadBalance = useServerFn(getBudgetBalance);
  const loadCash = useServerFn(getCashAvailability);
  const loadEquity = useServerFn(getEquityStatement);
  const loadFinancial = useServerFn(getFinancialBalance);
  const [exercicio, setExercicio] = useState(String(new Date().getFullYear()));
  const canReadCash = hasTenantPermission("accounting.read");

  const { data: balance } = useQuery({
    queryKey: ["budget-balance", activeTenant?.id, exercicio],
    enabled: Boolean(activeTenant) && /^\d{4}$/.test(exercicio),
    queryFn: () =>
      loadBalance({
        data: { tenant_id: activeTenant!.id, exercicio: Number(exercicio) },
      }),
  });
  const { data: cash } = useQuery({
    queryKey: ["cash-availability", activeTenant?.id],
    enabled: Boolean(activeTenant) && canReadCash,
    queryFn: () => loadCash({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: equity } = useQuery({
    queryKey: ["equity-statement", activeTenant?.id, exercicio],
    enabled: Boolean(activeTenant) && canReadCash && /^\d{4}$/.test(exercicio),
    queryFn: () =>
      loadEquity({
        data: { tenant_id: activeTenant!.id, exercicio: Number(exercicio) },
      }),
  });

  const { data: financial } = useQuery({
    queryKey: ["financial-balance", activeTenant?.id, exercicio],
    enabled: Boolean(activeTenant) && /^\d{4}$/.test(exercicio),
    queryFn: () =>
      loadFinancial({
        data: { tenant_id: activeTenant!.id, exercicio: Number(exercicio) },
      }),
  });

  // O2-17 — DFC (MCASP): fluxos operacional/investimento/financiamento do exercício.
  const loadCashFlow = useServerFn(getCashFlowStatement);
  const { data: dfc } = useQuery({
    queryKey: ["cash-flow-statement", activeTenant?.id, exercicio],
    enabled: Boolean(activeTenant) && /^\d{4}$/.test(exercicio),
    queryFn: () =>
      loadCashFlow({
        data: { tenant_id: activeTenant!.id, exercicio: Number(exercicio) },
      }),
  });

  // O4-14c — arrecadação tributária por origem (corrente × dívida ativa).
  const canReadTaxes = hasTenantPermission("taxes.read");
  const loadTaxOrigin = useServerFn(getTaxRevenueByOrigin);
  const { data: taxOrigin } = useQuery({
    queryKey: ["tax-revenue-origin", activeTenant?.id, exercicio],
    enabled: Boolean(activeTenant) && canReadTaxes && /^\d{4}$/.test(exercicio),
    queryFn: () =>
      loadTaxOrigin({
        data: { tenant_id: activeTenant!.id, exercicio: Number(exercicio) },
      }),
  });

  const resultado = balance?.resultado_orcamentario ?? 0;
  const resultadoPatrimonial = equity?.resultado_patrimonial ?? 0;
  const resultadoFinanceiro = financial?.resultado_financeiro ?? 0;

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <BarChart3 className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Balanços</h1>
            <p className="text-sm text-muted-foreground">
              Balanço orçamentário (Lei 4.320) e disponibilidade de caixa
            </p>
          </div>
        </div>
        <div className="w-32">
          <Label>Exercício</Label>
          <Input
            type="number"
            value={exercicio}
            onChange={(e) => setExercicio(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border bg-card p-4">
          <h2 className="font-bold mb-2">Receita</h2>
          <Row label="Prevista" value={balance?.receita.prevista ?? 0} />
          <Row label="Arrecadada" value={balance?.receita.arrecadada ?? 0} />
          <Row
            label="Diferença"
            value={balance?.receita.diferenca ?? 0}
            strong
          />
        </div>
        <div className="rounded-xl border bg-card p-4">
          <h2 className="font-bold mb-2">Despesa</h2>
          <Row label="Fixada" value={balance?.despesa.fixada ?? 0} />
          <Row label="Empenhada" value={balance?.despesa.empenhada ?? 0} />
          <Row label="Liquidada" value={balance?.despesa.liquidada ?? 0} />
          <Row label="Paga" value={balance?.despesa.paga ?? 0} />
          <Row
            label="Saldo de dotação"
            value={balance?.despesa.saldo_dotacao ?? 0}
            strong
          />
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h2 className="font-bold mb-2">Resultado orçamentário</h2>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">
            Receita arrecadada − despesa empenhada
          </span>
          <span
            className={`text-xl font-bold tabular-nums ${
              resultado >= 0 ? "text-emerald-600" : "text-red-600"
            }`}
          >
            {brl(resultado)} {resultado >= 0 ? "(superávit)" : "(déficit)"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border bg-card p-4">
          <h2 className="font-bold mb-2">Balanço financeiro — ingressos</h2>
          <Row
            label="Receita orçamentária"
            value={financial?.ingressos.receita_orcamentaria ?? 0}
          />
          <Row
            label="Extra — restos inscritos"
            value={financial?.ingressos.extraorcamentario_restos_inscritos ?? 0}
          />
          <Row
            label="Total de ingressos"
            value={financial?.ingressos.total ?? 0}
            strong
          />
        </div>
        <div className="rounded-xl border bg-card p-4">
          <h2 className="font-bold mb-2">Balanço financeiro — dispêndios</h2>
          <Row
            label="Despesa orçamentária paga"
            value={financial?.dispendios.despesa_orcamentaria ?? 0}
          />
          <Row
            label="Extra — restos pagos"
            value={financial?.dispendios.extraorcamentario_restos_pagos ?? 0}
          />
          <Row
            label="Total de dispêndios"
            value={financial?.dispendios.total ?? 0}
            strong
          />
          <div className="flex items-center justify-between pt-2">
            <span className="text-muted-foreground">Resultado financeiro</span>
            <span
              className={`font-bold tabular-nums ${
                resultadoFinanceiro >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {brl(resultadoFinanceiro)}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-bold">Demonstração dos fluxos de caixa (DFC)</h2>
          {dfc && (
            <span
              className={`text-xs font-semibold rounded-full px-2 py-0.5 ${
                dfc.conciliado
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {dfc.conciliado
                ? "conciliada com o caixa"
                : "não concilia com o caixa"}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {(
            [
              ["Operacional", dfc?.operacional],
              ["Investimento", dfc?.investimento],
              ["Financiamento", dfc?.financiamento],
            ] as const
          ).map(([titulo, f]) => (
            <div key={titulo}>
              <h3 className="text-sm font-semibold mb-1">{titulo}</h3>
              <Row label="Ingressos" value={f?.ingressos ?? 0} />
              <Row label="Desembolsos" value={f?.desembolsos ?? 0} />
              <Row label="Fluxo líquido" value={f?.liquido ?? 0} strong />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
          <Row
            label="Geração líquida de caixa"
            value={dfc?.geracao_liquida ?? 0}
            strong
          />
          <Row label="Caixa inicial" value={dfc?.caixa_inicial ?? 0} />
          <Row
            label="Variação do caixa (tesouraria)"
            value={dfc?.variacao_caixa ?? 0}
          />
          <Row label="Caixa final" value={dfc?.caixa_final ?? 0} strong />
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h2 className="font-bold mb-2">Restos a pagar inscritos</h2>
        <Row
          label="Processados"
          value={balance?.restos_a_pagar.processados ?? 0}
        />
        <Row
          label="Não processados"
          value={balance?.restos_a_pagar.nao_processados ?? 0}
        />
        <Row label="Total" value={balance?.restos_a_pagar.total ?? 0} strong />
      </div>

      {canReadCash && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-2 flex items-center justify-between gap-2 flex-wrap">
              <h2 className="font-bold">Balanço patrimonial</h2>
              {equity && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    equity.conferido
                      ? "bg-emerald-500/10 text-emerald-600"
                      : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {equity.conferido
                    ? "Fecha (ativo = passivo + PL)"
                    : "Não fecha (ativo ≠ passivo + PL)"}
                </span>
              )}
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              Saldos patrimoniais acumulados até o exercício; o grupo 2.3 é
              patrimônio líquido, não passivo exigível.
            </p>
            <Row label="Ativo" value={equity?.ativo ?? 0} />
            <Row label="Passivo exigível" value={equity?.passivo ?? 0} />
            <Row
              label="PL escriturado (2.3)"
              value={equity?.patrimonio_liquido_escriturado ?? 0}
            />
            <Row
              label="Resultado do período"
              value={equity?.resultado_patrimonial ?? 0}
            />
            <Row
              label="Patrimônio líquido"
              value={equity?.patrimonio_liquido ?? 0}
              strong
            />
          </div>
          <div className="rounded-xl border bg-card p-4">
            <h2 className="font-bold mb-2">Variações patrimoniais (DVP)</h2>
            <Row label="Aumentativas (VPA)" value={equity?.vpa ?? 0} />
            <Row label="Diminutivas (VPD)" value={equity?.vpd ?? 0} />
            <div className="flex items-center justify-between pt-2">
              <span className="text-muted-foreground">
                Resultado patrimonial (VPA − VPD)
              </span>
              <span
                className={`font-bold tabular-nums ${
                  resultadoPatrimonial >= 0
                    ? "text-emerald-600"
                    : "text-red-600"
                }`}
              >
                {brl(resultadoPatrimonial)}
              </span>
            </div>
          </div>
        </div>
      )}

      {canReadTaxes && (
        <div className="rounded-xl border bg-card p-4">
          <h2 className="font-bold">Arrecadação tributária por origem</h2>
          <p className="mb-2 text-xs text-muted-foreground">
            Cobrança corrente × receita de dívida ativa (Lei 6.830), pela origem
            gravada em cada pagamento.
          </p>
          <Row
            label="Cobrança corrente"
            value={taxOrigin?.totais.corrente ?? 0}
          />
          <Row
            label="Receita de dívida ativa"
            value={taxOrigin?.totais.divida_ativa ?? 0}
          />
          <Row
            label="Total arrecadado"
            value={taxOrigin?.totais.total ?? 0}
            strong
          />
        </div>
      )}

      {canReadCash && (
        <div className="rounded-xl border bg-card p-4">
          <h2 className="font-bold mb-2">Disponibilidade de caixa</h2>
          <Row
            label="Saldo consolidado (contas ativas)"
            value={cash?.saldo_consolidado ?? 0}
            strong
          />
          <Row label="Ingressos (período)" value={cash?.ingressos ?? 0} />
          <Row label="Saídas (período)" value={cash?.saidas ?? 0} />
          <Row label="Fluxo líquido" value={cash?.fluxo_liquido ?? 0} strong />
        </div>
      )}
    </section>
  );
}
