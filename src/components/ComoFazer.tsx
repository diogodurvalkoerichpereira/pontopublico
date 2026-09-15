import { useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ChevronDown, HelpCircle } from "lucide-react";
import { ajudaDaRota } from "@/lib/ajuda-telas";

/**
 * Painel "Como fazer" da tela atual.
 *
 * Fica no `AppShell`, que já sabe a rota — assim toda tela ganha o roteiro sem
 * que nenhuma precise saber que ele existe. Nasce recolhido: quem já sabe operar
 * não tropeça nele, e quem não sabe tem onde olhar sem sair da tela.
 *
 * O texto vive em `src/lib/ajuda-telas.ts`, num módulo só, para ser revisável de
 * uma vez — espalhar a ajuda pelas rotas é como ela envelhece sem ninguém notar.
 */
export function ComoFazer() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const ajuda = ajudaDaRota(pathname);
  const [aberto, setAberto] = useState(false);

  if (!ajuda) return null;

  return (
    <div className="mb-4 rounded-xl border bg-card">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-semibold transition-colors hover:bg-muted/40"
      >
        <HelpCircle className="size-4 flex-shrink-0 text-primary" />
        <span>Como fazer: {ajuda.titulo}</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs font-normal text-muted-foreground sm:inline">
            {ajuda.passos.length} operaç
            {ajuda.passos.length === 1 ? "ão" : "ões"}
          </span>
          <ChevronDown
            className={`size-4 transition-transform ${aberto ? "" : "-rotate-90"}`}
          />
        </span>
      </button>

      {aberto && (
        <div className="border-t px-4 py-3">
          <p className="mb-3 text-sm text-muted-foreground">{ajuda.resumo}</p>
          <ol className="space-y-3">
            {ajuda.passos.map((p) => (
              <li key={p.acao} className="text-sm">
                <span className="font-semibold">{p.acao}.</span>{" "}
                <span>{p.como}</span>
                {p.atencao && (
                  <div className="mt-1 rounded-md border-l-2 border-amber-400 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    {p.atencao}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
