// O5-02 — Portal da transparência (Onda 5, LAI/Lei 12.527). Relatório consolidado
// de leitura sobre dados que já existem: execução da despesa, receita e contratos.
// Sem tabelas próprias; só agrega.
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

const num = (v: unknown) => Number(v ?? 0);

export const getTransparencyReport = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "transparency.read");

    // Separar as agregações evita fan-out do join (o orçado seria multiplicado
    // pelo número de empenhos da dotação).
    const orcadoRow = await queryOne<{ orcado: string }>(
      `select coalesce(sum(valor_orcado),0)::text as orcado
       from public.budget_appropriations
       where tenant_id = $1 and exercicio = $2`,
      [data.tenant_id, data.exercicio],
    );
    const despesa = await queryOne<{
      empenhado: string;
      liquidado: string;
      pago: string;
    }>(
      `select
         coalesce(sum(c.valor) filter (where c.status <> 'anulado'),0)::text as empenhado,
         coalesce(sum(c.valor) filter (where c.status in ('liquidado','pago')),0)::text as liquidado,
         coalesce(sum(c.valor) filter (where c.status = 'pago'),0)::text as pago
       from public.budget_commitments c
       where c.tenant_id = $1 and c.exercicio = $2`,
      [data.tenant_id, data.exercicio],
    );

    const receita = await queryOne<{
      previsto: string;
      arrecadado: string;
    }>(
      `select coalesce(sum(valor_previsto),0)::text as previsto,
              coalesce(sum(valor_arrecadado),0)::text as arrecadado
       from public.budget_revenues where tenant_id = $1 and exercicio = $2`,
      [data.tenant_id, data.exercicio],
    );

    const contratos = await queryOne<{
      quantidade: string;
      valor_total: string;
    }>(
      `select count(*)::text as quantidade,
              coalesce(sum(valor_total),0)::text as valor_total
       from public.procurement_contracts
       where tenant_id = $1 and ano = $2 and status <> 'rescindido'`,
      [data.tenant_id, data.exercicio],
    );

    const orcado = num(orcadoRow?.orcado);
    const empenhado = num(despesa?.empenhado);
    const previsto = num(receita?.previsto);
    const arrecadado = num(receita?.arrecadado);
    return {
      exercicio: data.exercicio,
      despesa: {
        orcado,
        empenhado,
        liquidado: num(despesa?.liquidado),
        pago: num(despesa?.pago),
        saldo: Number((orcado - empenhado).toFixed(2)),
      },
      receita: {
        previsto,
        arrecadado,
        a_realizar: Number((previsto - arrecadado).toFixed(2)),
      },
      contratos: {
        quantidade: num(contratos?.quantidade),
        valor_total: num(contratos?.valor_total),
      },
      // Resultado orçamentário simplificado (arrecadado − pago).
      resultado_orcamentario: Number(
        (arrecadado - num(despesa?.pago)).toFixed(2),
      ),
    };
  });
