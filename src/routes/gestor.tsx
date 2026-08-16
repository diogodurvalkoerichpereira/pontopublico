import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChartNoAxesCombined } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/lib/auth-context";
import { getManagerDashboard } from "@/lib/manager-dashboard.functions";
export const Route = createFileRoute("/gestor")({ component: Page });
function Page() {
  const { activeTenant } = useAuth(),
    load = useServerFn(getManagerDashboard);
  const { data } = useQuery({
    queryKey: ["manager", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const h: any = data?.headcount || {};
  return (
    <AppShell>
      <section className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold">
            <ChartNoAxesCombined />
            Painel gestor
          </h1>
          <p className="text-sm text-muted-foreground">
            Folha fechada, quadro funcional e movimentações reconciliadas.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <K t="Ativos" v={h.ativos} />
          <K t="Afastados" v={h.afastados} />
          <K t="Desligados" v={h.desligados} />
          <K t="Idade média" v={Number(h.idade_media || 0).toFixed(1)} />
        </div>
        <div className="rounded-2xl border bg-card p-5">
          <h2 className="mb-3 font-bold">Evolução da folha</h2>
          {data?.series.map((x: any) => (
            <div
              key={x.reference_month}
              className="grid grid-cols-4 border-b py-2 text-sm"
            >
              <span>{x.reference_month.slice(0, 7)}</span>
              <span>Bruto R$ {Number(x.bruto).toFixed(2)}</span>
              <span>Descontos R$ {Number(x.descontos).toFixed(2)}</span>
              <b>Líquido R$ {Number(x.liquido).toFixed(2)}</b>
            </div>
          ))}
        </div>
        <div className="rounded-2xl border bg-card p-5">
          <h2 className="mb-3 font-bold">Por unidade</h2>
          {data?.units.map((u: any) => (
            <div className="flex justify-between border-b py-2" key={u.unidade}>
              <span>{u.unidade}</span>
              <b>
                {u.servidores} servidores · R$ {Number(u.massa_base).toFixed(2)}
              </b>
            </div>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
function K({ t, v }: { t: string; v: unknown }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs uppercase text-muted-foreground">{t}</p>
      <b className="text-2xl">{String(v ?? 0)}</b>
    </div>
  );
}
