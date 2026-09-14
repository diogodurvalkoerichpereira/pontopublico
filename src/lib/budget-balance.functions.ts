// O2-10 — Balanço orçamentário (Onda 2, Lei 4.320, Anexo 1). Consolida o exercício:
// RECEITA (prevista × arrecadada) e DESPESA (fixada × empenhada × liquidada × paga),
// o resultado orçamentário (arrecadada − empenhada) e os restos a pagar inscritos.
// Read-only; cada total vem de sua própria consulta (sem JOIN, para não inflar soma
// por fan-out). Reusa budget.read.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { queryOne } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const Input = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
});

export const getBudgetBalance = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(Input, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");

    const receitaRow = await queryOne<{
      prevista: string;
      arrecadada: string;
    }>(
      `select coalesce(sum(valor_previsto),0)::text as prevista,
         coalesce(sum(valor_arrecadado),0)::text as arrecadada
       from public.budget_revenues
       where tenant_id = $1 and exercicio = $2`,
      [data.tenant_id, data.exercicio],
    );

    const despesaRow = await queryOne<{
      fixada: string;
      empenhada: string;
      liquidada: string;
      paga: string;
    }>(
      `select
         (select coalesce(sum(valor_orcado),0) from public.budget_appropriations
          where tenant_id=$1 and exercicio=$2)::text as fixada,
         coalesce(sum(valor) filter (where status <> 'anulado'),0)::text as empenhada,
         coalesce(sum(valor) filter (where status in ('liquidado','pago')),0)::text as liquidada,
         coalesce(sum(valor) filter (where status = 'pago'),0)::text as paga
       from public.budget_commitments
       where tenant_id=$1 and exercicio=$2`,
      [data.tenant_id, data.exercicio],
    );

    const restosRow = await queryOne<{
      processados: string;
      nao_processados: string;
      total: string;
    }>(
      // Só o estoque AINDA A PAGAR (inscrito): resto pago ou cancelado não é
      // saldo de restos a pagar — contá-lo inflava o Anexo 1 do exercício.
      `select
         coalesce(sum(valor) filter (where tipo='processado' and status='inscrito'),0)::text as processados,
         coalesce(sum(valor) filter (where tipo='nao_processado' and status='inscrito'),0)::text as nao_processados,
         coalesce(sum(valor) filter (where status='inscrito'),0)::text as total
       from public.restos_a_pagar
       where tenant_id=$1 and exercicio_origem=$2`,
      [data.tenant_id, data.exercicio],
    );

    const prevista = Number(receitaRow?.prevista ?? 0);
    const arrecadada = Number(receitaRow?.arrecadada ?? 0);
    const fixada = Number(despesaRow?.fixada ?? 0);
    const empenhada = Number(despesaRow?.empenhada ?? 0);
    const liquidada = Number(despesaRow?.liquidada ?? 0);
    const paga = Number(despesaRow?.paga ?? 0);
    const n2 = (v: number) => Number(v.toFixed(2));

    return {
      exercicio: data.exercicio,
      receita: {
        prevista: n2(prevista),
        arrecadada: n2(arrecadada),
        diferenca: n2(arrecadada - prevista),
      },
      despesa: {
        fixada: n2(fixada),
        empenhada: n2(empenhada),
        liquidada: n2(liquidada),
        paga: n2(paga),
        saldo_dotacao: n2(fixada - empenhada),
      },
      // Resultado orçamentário (Lei 4.320): receita arrecadada − despesa empenhada.
      // Positivo = superávit; negativo = déficit.
      resultado_orcamentario: n2(arrecadada - empenhada),
      restos_a_pagar: {
        processados: Number(restosRow?.processados ?? 0),
        nao_processados: Number(restosRow?.nao_processados ?? 0),
        total: Number(restosRow?.total ?? 0),
      },
    };
  });
