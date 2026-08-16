import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { LifeBuoy, X } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import {
  findContextualHelp,
  openSupportConversation,
} from "@/lib/support.functions";
export function SupportWidget() {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(""),
    [message, setMessage] = useState(""),
    { activeTenant, hasTenantPermission } = useAuth(),
    find = useServerFn(findContextualHelp),
    createConversation = useServerFn(openSupportConversation),
    route = typeof location !== "undefined" ? location.pathname : "/";
  const q = useQuery({
    queryKey: ["help", activeTenant?.id, route, search],
    enabled: open && !!activeTenant && hasTenantPermission("support.use"),
    queryFn: () =>
      find({ data: { tenant_id: activeTenant!.id, route, search } }),
  });
  const ticket = useMutation({
    mutationFn: () =>
      createConversation({
        data: {
          tenant_id: activeTenant!.id,
          route_context: route,
          subject: `Ajuda em ${route}`,
          message,
        },
      }),
    onSuccess: () => setMessage(""),
  });
  if (!activeTenant || !hasTenantPermission("support.use")) return null;
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Ajuda e suporte"
        className="fixed bottom-5 right-5 z-50 rounded-full bg-primary p-4 text-primary-foreground shadow-xl"
      >
        <LifeBuoy />
      </button>
      {open && (
        <aside className="fixed bottom-20 right-5 z-50 w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-card p-4 shadow-2xl">
          <div className="mb-3 flex justify-between">
            <b>Ajuda desta tela</b>
            <button onClick={() => setOpen(false)}>
              <X className="size-4" />
            </button>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar ajuda"
            className="mb-3 w-full rounded border bg-background px-3 py-2"
          />
          {q.data?.map((a: any) => (
            <details key={a.id} className="border-b py-2">
              <summary className="cursor-pointer font-medium">
                {a.title}
              </summary>
              <p className="mt-2 text-sm text-muted-foreground">{a.content}</p>
            </details>
          ))}
          <form
            className="mt-3 space-y-2 border-t pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (message.trim().length >= 3) ticket.mutate();
            }}
          >
            <label className="text-xs font-semibold">Falar com o suporte</label>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Descreva sua dúvida"
              className="h-20 w-full rounded border bg-background p-2 text-sm"
            />
            <button
              disabled={ticket.isPending || message.trim().length < 3}
              className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50"
            >
              {ticket.isPending ? "Enviando…" : "Abrir conversa"}
            </button>
            {ticket.data && (
              <p className="text-xs text-green-700">
                Conversa aberta: {ticket.data.id.slice(0, 8)}
              </p>
            )}
          </form>
        </aside>
      )}
    </>
  );
}
