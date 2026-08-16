import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArchiveRestore } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/lib/auth-context";
import { listMigrationJobs } from "@/lib/historical-migration.functions";
export const Route = createFileRoute("/admin/migracao-historica")({
  component: Page,
});
function Page() {
  const { activeTenant } = useAuth(),
    load = useServerFn(listMigrationJobs);
  const q = useQuery({
    queryKey: ["historical-migrations", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  return (
    <AppShell>
      <section className="space-y-5">
        <div>
          <h1 className="flex gap-2 text-2xl font-extrabold">
            <ArchiveRestore />
            Migração histórica
          </h1>
          <p className="text-sm text-muted-foreground">
            Staging idempotente, validação de 15 anos e reconciliação antes do
            arquivo definitivo.
          </p>
        </div>
        {q.data?.map((j: any) => (
          <div
            key={j.id}
            className="grid gap-2 rounded-xl border bg-card p-4 md:grid-cols-4"
          >
            <span>
              <b>{j.name}</b>
              <br />
              <small>{j.source_type}</small>
            </span>
            <span>
              {j.valid_rows}/{j.expected_rows} válidos
            </span>
            <span>
              R$ {Number(j.staged_total).toFixed(2)} / R${" "}
              {Number(j.expected_total).toFixed(2)}
            </span>
            <b>{j.status}</b>
          </div>
        ))}
      </section>
    </AppShell>
  );
}
