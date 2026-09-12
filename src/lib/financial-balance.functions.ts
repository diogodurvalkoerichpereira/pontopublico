// O2-25 — Balanço financeiro (Onda 2, Lei 4.320 Anexo 13). Confronta, no exercício, os
// INGRESSOS (receita orçamentária arrecadada + inscrição de restos a pagar como ingresso
// extraorçamentário) com os DISPÊNDIOS (despesa orçamentária paga + pagamento de restos a
// pagar como dispêndio extraorçamentário) e apura o resultado financeiro. Os restos são
// datados: inscrição pelo ano de `inscrito_em`, pagamento pelo ano de `pago_em`. Read-only,
// reusa budget.read.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
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

export const getFinancialBalance = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");

    // Receita orçamentária arrecadada no exercício.
    const receita = await queryOne<{ arrecadada: string }>(
      `select coalesce(sum(valor_arrecadado),0)::text as arrecadada
       from public.budget_revenues
       where tenant_id=$1 and exercicio=$2`,
      [data.tenant_id, data.exercicio],
    );

    // Despesa orçamentária paga no exercício.
    const despesa = await queryOne<{ paga: string }>(
      `select coalesce(sum(valor),0)::text as paga
       from public.budget_commitments
       where tenant_id=$1 and exercicio=$2 and status='pago'`,
      [data.tenant_id, data.exercicio],
    );

    // Extraorçamentário: restos a pagar inscritos (ingresso) e pagos (dispêndio) no ano.
    const restos = await queryOne<{ inscritos: string; pagos: string }>(
      `select
         coalesce(sum(valor) filter (where extract(year from inscrito_em)=$2),0)::text as inscritos,
         coalesce(sum(valor) filter (where status='pago' and extract(year from pago_em)=$2),0)::text as pagos
       from public.restos_a_pagar
       where tenant_id=$1`,
      [data.tenant_id, data.exercicio],
    );

    const n2 = (v: number) => Number(v.toFixed(2));
    const receitaOrcamentaria = Number(receita?.arrecadada ?? 0);
    const despesaOrcamentaria = Number(despesa?.paga ?? 0);
    const restosInscritos = Number(restos?.inscritos ?? 0);
    const restosPagos = Number(restos?.pagos ?? 0);

    const ingressos = n2(receitaOrcamentaria + restosInscritos);
    const dispendios = n2(despesaOrcamentaria + restosPagos);

    return {
      exercicio: data.exercicio,
      ingressos: {
        receita_orcamentaria: n2(receitaOrcamentaria),
        extraorcamentario_restos_inscritos: n2(restosInscritos),
        total: ingressos,
      },
      dispendios: {
        despesa_orcamentaria: n2(despesaOrcamentaria),
        extraorcamentario_restos_pagos: n2(restosPagos),
        total: dispendios,
      },
      // Resultado financeiro do exercício: ingressos − dispêndios.
      resultado_financeiro: n2(ingressos - dispendios),
    };
  });
