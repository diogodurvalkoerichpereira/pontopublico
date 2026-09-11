// O2-14 — Execução da receita por natureza (Onda 2, Lei 4.320). Consolida, por
// natureza de receita, o previsto, o arrecadado e o a arrecadar no exercício —
// o espelho, do lado da receita, da execução da despesa. Read-only, reusa
// budget.read.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const Input = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
});

export const getRevenueExecution = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    const rows = await query<{
      natureza_receita: string;
      previsto: string;
      arrecadado: string;
    }>(
      `select natureza_receita,
         coalesce(sum(valor_previsto),0)::text as previsto,
         coalesce(sum(valor_arrecadado),0)::text as arrecadado
       from public.budget_revenues
       where tenant_id = $1 and exercicio = $2
       group by natureza_receita
       order by natureza_receita`,
      [data.tenant_id, data.exercicio],
    );
    const naturezas = rows.map((r) => {
      const previsto = Number(r.previsto);
      const arrecadado = Number(r.arrecadado);
      return {
        natureza_receita: r.natureza_receita,
        previsto: Number(previsto.toFixed(2)),
        arrecadado: Number(arrecadado.toFixed(2)),
        // A arrecadar não fica negativo (excesso de arrecadação é zero aqui).
        a_arrecadar: Number(Math.max(previsto - arrecadado, 0).toFixed(2)),
      };
    });
    const totais = naturezas.reduce(
      (acc, n) => ({
        previsto: acc.previsto + n.previsto,
        arrecadado: acc.arrecadado + n.arrecadado,
      }),
      { previsto: 0, arrecadado: 0 },
    );
    const previstoTotal = Number(totais.previsto.toFixed(2));
    const arrecadadoTotal = Number(totais.arrecadado.toFixed(2));
    return {
      exercicio: data.exercicio,
      naturezas,
      totais: {
        previsto: previstoTotal,
        arrecadado: arrecadadoTotal,
        a_arrecadar: Number(
          Math.max(previstoTotal - arrecadadoTotal, 0).toFixed(2),
        ),
      },
    };
  });
