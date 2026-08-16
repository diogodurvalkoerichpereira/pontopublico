import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BadgeDollarSign } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { getMyFinancialPortal } from "@/lib/employee-finance.functions";
export const Route = createFileRoute("/portal-financeiro")({ component: Page });
function Page() {
  const load = useServerFn(getMyFinancialPortal);
  const { data } = useQuery({
    queryKey: ["my-finance"],
    queryFn: () => load(),
  });
  return (
    <AppShell>
      <section className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold">
            <BadgeDollarSign />
            Portal financeiro
          </h1>
          <p className="text-sm text-muted-foreground">
            Seus contracheques, férias e margem consignável.
          </p>
        </div>
        <div className="rounded-2xl border bg-card p-5">
          <p className="text-xs uppercase text-muted-foreground">
            Margem estimada
          </p>
          <b className="text-3xl">R$ {Number(data?.margin || 0).toFixed(2)}</b>
        </div>
        {data?.payslips.map((p: any) => (
          <div key={p.id} className="rounded-xl border bg-card p-4">
            <b>Contracheque {p.reference_month.slice(0, 7)}</b>
            <p>Líquido: R$ {Number(p.payload.net_amount).toFixed(2)}</p>
            <code className="text-xs">
              Verificação {p.verification_code} · SHA-256 {p.document_sha256}
            </code>
          </div>
        ))}
      </section>
    </AppShell>
  );
}
