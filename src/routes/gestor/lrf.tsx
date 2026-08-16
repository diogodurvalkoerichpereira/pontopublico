import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Scale } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/lib/auth-context";
import { getFiscalDashboard } from "@/lib/fiscal-dashboard.functions";
export const Route = createFileRoute("/gestor/lrf")({ component: Page });
function Page() {
  const { activeTenant } = useAuth(),
    load = useServerFn(getFiscalDashboard);
  const { data } = useQuery({
    queryKey: ["lrf", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const pct = (n = 0) => (n * 100).toFixed(2) + "%";
  return (
    <AppShell>
      <section className="space-y-5">
        <div>
          <h1 className="flex gap-2 text-2xl font-extrabold">
            <Scale />
            LRF e RCL
          </h1>
          <p className="text-sm text-muted-foreground">
            Janela móvel de 12 meses, parâmetros auditáveis e alertas.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <K t="RCL" v={`R$ ${Number(data?.rcl || 0).toFixed(2)}`} />
          <K t="Pessoal" v={`R$ ${Number(data?.personnel || 0).toFixed(2)}`} />
          <K t="Percentual" v={pct(data?.ratio)} />
          <K t="Situação" v={data?.level || "sem dados"} />
        </div>
        <div className="rounded-xl border bg-card p-4 text-sm">
          <b>Faixas:</b> alerta {pct(data?.warning)} · prudencial{" "}
          {pct(data?.prudential)} · legal {pct(data?.legalLimit)}
          <p className="mt-2 text-muted-foreground">
            {data?.legalBasis}. O cálculo depende dos dados oficiais inseridos e
            deve ser conferido pelo controle interno.
          </p>
          {data?.sourceUrl && (
            <a
              className="text-primary underline"
              href={data.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Fonte legal oficial
            </a>
          )}
        </div>
      </section>
    </AppShell>
  );
}
function K({ t, v }: { t: string; v: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs uppercase text-muted-foreground">{t}</p>
      <b className="text-xl">{v}</b>
    </div>
  );
}
