import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import {
  getTransparencyReport,
  getTransparencyByFunction,
  getOpenDataTransparencia,
  getEsicStatistics,
} from "@/lib/transparency.functions";

export const Route = createFileRoute("/transparencia")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("transparency.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Report = {
  despesa: {
    orcado: number;
    empenhado: number;
    liquidado: number;
    pago: number;
    saldo: number;
  };
  receita: { previsto: number; arrecadado: number; a_realizar: number };
  contratos: { quantidade: number; valor_total: number };
  resultado_orcamentario: number;
};
type Funcao = {
  funcao: string;
  empenhado: number;
  liquidado: number;
  pago: number;
};

const brl = (v: number) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function Content() {
  const { activeTenant } = useAuth();
  const loadReport = useServerFn(getTransparencyReport);
  const loadByFunction = useServerFn(getTransparencyByFunction);
  const loadOpenData = useServerFn(getOpenDataTransparencia);
  const [ano, setAno] = useState(new Date().getFullYear());
  const [baixando, setBaixando] = useState(false);

  const baixarDadosAbertos = async () => {
    if (!activeTenant) return;
    setBaixando(true);
    try {
      const payload = await loadOpenData({
        data: { tenant_id: activeTenant.id, exercicio: ano },
      });
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dados-abertos-transparencia-${ano}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setBaixando(false);
    }
  };

  const { data: report } = useQuery({
    queryKey: ["transparency-report", activeTenant?.id, ano],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadReport({ data: { tenant_id: activeTenant!.id, exercicio: ano } }),
  });
  const { data: byFunction } = useQuery({
    queryKey: ["transparency-by-function", activeTenant?.id, ano],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadByFunction({ data: { tenant_id: activeTenant!.id, exercicio: ano } }),
  });
  // O5-10 — estatística do e-SIC (LAI art. 30, III), publicação anual obrigatória.
  const loadEsicStats = useServerFn(getEsicStatistics);
  const { data: esicStats } = useQuery({
    queryKey: ["transparency-esic-stats", activeTenant?.id, ano],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadEsicStats({ data: { tenant_id: activeTenant!.id, exercicio: ano } }),
  });
  if (!activeTenant) return null;

  const r = report as Report | undefined;
  const funcoes = (byFunction?.funcoes ?? []) as Funcao[];

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Eye className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Portal da Transparência
            </h1>
            <p className="text-sm text-muted-foreground">
              Execução da despesa e da receita do exercício (LAI / LC 131)
            </p>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-32">
            <Label>Exercício</Label>
            <Input
              type="number"
              value={ano}
              onChange={(e) => setAno(Number(e.target.value))}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={baixarDadosAbertos}
            disabled={baixando}
          >
            <Download className="size-3.5 mr-1" />
            Dados abertos (JSON)
          </Button>
        </div>
      </div>

      {r && (
        <>
          <h2 className="text-lg font-bold">Despesa</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card label="Orçado" value={brl(r.despesa.orcado)} />
            <Card label="Empenhado" value={brl(r.despesa.empenhado)} />
            <Card label="Liquidado" value={brl(r.despesa.liquidado)} />
            <Card label="Pago" value={brl(r.despesa.pago)} />
          </div>
          <h2 className="text-lg font-bold">Receita</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card label="Prevista" value={brl(r.receita.previsto)} />
            <Card label="Arrecadada" value={brl(r.receita.arrecadado)} />
            <Card label="A realizar" value={brl(r.receita.a_realizar)} />
            <Card
              label="Resultado orçamentário"
              value={brl(r.resultado_orcamentario)}
            />
          </div>
        </>
      )}

      {esicStats && (
        <>
          <h2 className="text-lg font-bold">
            Acesso à informação — estatística do e-SIC (LAI art. 30, III)
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card
              label="Pedidos recebidos"
              value={String(esicStats.pedidos.recebidos)}
            />
            <Card
              label="Atendidos"
              value={`${esicStats.pedidos.atendidos} (${esicStats.pedidos.taxa_atendimento.toFixed(2)}%)`}
            />
            <Card
              label="Indeferidos"
              value={String(esicStats.pedidos.indeferidos)}
            />
            <Card
              label="Em aberto / prorrogados"
              value={`${esicStats.pedidos.em_aberto} / ${esicStats.pedidos.prorrogados}`}
            />
            <Card
              label="Respondidos no prazo"
              value={String(esicStats.pedidos.respondidos_no_prazo)}
            />
            <Card
              label="Recursos interpostos"
              value={String(esicStats.recursos.interpostos)}
            />
            <Card
              label="Recursos providos"
              value={String(esicStats.recursos.providos)}
            />
            <Card
              label="Recursos improvidos / pendentes"
              value={`${esicStats.recursos.improvidos} / ${esicStats.recursos.pendentes}`}
            />
          </div>
        </>
      )}

      <div>
        <h2 className="mb-2 text-lg font-bold">
          Despesa por função de governo
        </h2>
        <div className="rounded-xl border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Função</th>
                <th className="p-3 font-semibold text-right">Empenhado</th>
                <th className="p-3 font-semibold text-right">Liquidado</th>
                <th className="p-3 font-semibold text-right">Pago</th>
              </tr>
            </thead>
            <tbody>
              {funcoes.map((f) => (
                <tr key={f.funcao} className="border-b last:border-0">
                  <td className="p-3 font-medium">{f.funcao}</td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(f.empenhado)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(f.liquidado)}
                  </td>
                  <td className="p-3 text-right tabular-nums">{brl(f.pago)}</td>
                </tr>
              ))}
              {funcoes.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="p-6 text-center text-muted-foreground"
                  >
                    Sem despesa executada no exercício.
                  </td>
                </tr>
              )}
            </tbody>
            {byFunction && funcoes.length > 0 && (
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="p-3">Total</td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(byFunction.totais.empenhado)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(byFunction.totais.liquidado)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(byFunction.totais.pago)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </section>
  );
}
