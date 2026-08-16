import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft, ChevronRight, FileClock, Search } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getAuditEvents, type AuditEventView } from "@/lib/audit.functions";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/admin/auditoria")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("audit.read")) {
      toast.error("Sem acesso à auditoria");
      nav({ to: "/app" });
    }
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

function Content() {
  const { activeTenant } = useAuth();
  const loadEvents = useServerFn(getAuditEvents);
  const [search, setSearch] = useState("");
  const [resource, setResource] = useState("");
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AuditEventView | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: [
      "audit-events",
      activeTenant?.id,
      search,
      resource,
      action,
      page,
    ],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadEvents({
        data: {
          tenant_id: activeTenant!.id,
          search,
          resource,
          action,
          page,
          page_size: 30,
        },
      }),
  });
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 30));

  if (!activeTenant)
    return (
      <div className="rounded-xl border bg-amber-50 p-6">
        Selecione uma entidade ativa.
      </div>
    );
  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3">
        <FileClock className="size-7 text-primary" />
        <div>
          <h1 className="text-2xl font-extrabold">Auditoria</h1>
          <p className="text-sm text-muted-foreground">
            {activeTenant.nome} · operador, data e valores antes/depois.
          </p>
        </div>
      </div>
      <div className="grid gap-3 rounded-2xl border bg-card p-4 shadow-sm md:grid-cols-[1fr_210px_180px]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Registro, requisição ou operador"
          />
        </div>
        <Input
          value={resource}
          onChange={(e) => {
            setResource(e.target.value);
            setPage(1);
          }}
          placeholder="Recurso (ex.: employment_links)"
        />
        <Input
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
          placeholder="Ação (create/update)"
        />
      </div>
      <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/60 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Data</th>
                <th className="px-4 py-3">Operador</th>
                <th className="px-4 py-3">Ação</th>
                <th className="px-4 py-3">Recurso</th>
                <th className="px-4 py-3">Registro</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data?.events.map((event) => (
                <tr key={event.id} className="hover:bg-muted/30">
                  <td className="whitespace-nowrap px-4 py-3">
                    {new Date(event.created_at).toLocaleString("pt-BR")}
                  </td>
                  <td className="px-4 py-3">
                    <span className="block font-medium">
                      {event.actor_name || "Sistema"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {event.actor_email}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline">{event.action}</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {event.resource}
                  </td>
                  <td className="max-w-56 truncate px-4 py-3 font-mono text-xs">
                    {event.record_id || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(event)}
                    >
                      Comparar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {isLoading && (
          <p className="p-8 text-center text-muted-foreground">Carregando...</p>
        )}
        {!isLoading && !data?.events.length && (
          <p className="p-8 text-center text-muted-foreground">
            Nenhum evento encontrado.
          </p>
        )}
        <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
          <span>{data?.total ?? 0} evento(s)</span>
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span>
              {page} / {pages}
            </span>
            <Button
              size="icon"
              variant="outline"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Evento #{selected?.id} · {selected?.resource}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <JsonPanel title="Antes" value={selected?.before_data ?? null} />
            <JsonPanel title="Depois" value={selected?.after_data ?? null} />
          </div>
          <p className="text-xs text-muted-foreground">
            Request ID: {selected?.request_id || "—"} · IP:{" "}
            {selected?.ip || "—"}
          </p>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-bold">{title}</h3>
      <pre className="max-h-96 overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100">
        {value == null ? "Sem valor" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
