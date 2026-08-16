import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot, Send } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/lib/auth-context";
import { askAnalytics, saveSemanticPanel } from "@/lib/ai-analytics.functions";
export const Route = createFileRoute("/gestor/assistente")({ component: Page });
function Page() {
  const { activeTenant } = useAuth(),
    [question, setQuestion] = useState(""),
    ask = useServerFn(askAnalytics),
    save = useServerFn(saveSemanticPanel),
    m = useMutation({
      mutationFn: () =>
        ask({ data: { tenant_id: activeTenant!.id, question } }),
    }),
    panel = useMutation({
      mutationFn: () =>
        save({
          data: {
            tenant_id: activeTenant!.id,
            title: question.slice(0, 120),
            metric_code: m.data!.metric!,
          },
        }),
    });
  return (
    <AppShell>
      <section className="mx-auto max-w-4xl space-y-5">
        <div>
          <h1 className="flex gap-2 text-2xl font-extrabold">
            <Bot />
            Assistente analítico
          </h1>
          <p className="text-sm text-muted-foreground">
            Pergunte sobre folha, descontos, servidores ou LRF. Toda resposta
            informa sua evidência.
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (activeTenant && question.trim()) m.mutate();
          }}
          className="flex gap-2"
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ex.: qual foi a folha líquida mais recente?"
            className="flex-1 rounded border bg-background px-3"
          />
          <button className="rounded bg-primary p-3 text-primary-foreground">
            <Send />
          </button>
        </form>
        {m.data && (
          <article className="rounded-xl border bg-card p-5">
            <p className="text-lg">{m.data.answer}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              Fonte: {m.data.evidence.source} · {m.data.evidence.rows}{" "}
              registro(s). Não executa SQL livre.
            </p>
            {m.data.metric && (
              <button
                onClick={() => panel.mutate()}
                className="mt-3 rounded border px-3 py-2 text-sm"
              >
                {panel.data ? "Painel salvo" : "Salvar como painel"}
              </button>
            )}
          </article>
        )}
      </section>
    </AppShell>
  );
}
