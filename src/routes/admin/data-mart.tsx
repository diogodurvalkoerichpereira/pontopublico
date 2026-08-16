import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { DatabaseZap } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/lib/auth-context";
import { getDataMartStatus, refreshDataMart } from "@/lib/data-mart.functions";
export const Route = createFileRoute("/admin/data-mart")({ component: Page });
function Page() {
  const { activeTenant } = useAuth(),
    qc = useQueryClient(),
    get = useServerFn(getDataMartStatus),
    refresh = useServerFn(refreshDataMart);
  const q = useQuery({
    queryKey: ["mart", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () => get({ data: { tenant_id: activeTenant!.id } }),
  });
  const m = useMutation({
    mutationFn: () => refresh({ data: { tenant_id: activeTenant!.id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mart"] }),
  });
  return (
    <AppShell>
      <section className="space-y-5">
        <div>
          <h1 className="flex gap-2 text-2xl font-extrabold">
            <DatabaseZap />
            Data mart
          </h1>
          <p className="text-sm text-muted-foreground">
            Carga incremental e reconciliação da folha fechada.
          </p>
        </div>
        <button
          disabled={!activeTenant || m.isPending}
          onClick={() => m.mutate()}
          className="rounded bg-primary px-4 py-2 text-primary-foreground"
        >
          {m.isPending ? "Atualizando…" : "Atualizar e reconciliar"}
        </button>
        {q.data?.runs.map((r: any) => (
          <div
            key={r.id}
            className="grid grid-cols-4 rounded border bg-card p-3 text-sm"
          >
            <span>{new Date(r.started_at).toLocaleString("pt-BR")}</span>
            <span>
              {r.source_rows} → {r.mart_rows} registros
            </span>
            <span>R$ {Number(r.mart_total).toFixed(2)}</span>
            <b className={r.reconciled ? "text-green-700" : "text-red-700"}>
              {r.reconciled ? "Reconciliado" : "Divergente"}
            </b>
          </div>
        ))}
      </section>
    </AppShell>
  );
}
