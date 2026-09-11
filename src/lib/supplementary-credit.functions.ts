// O2-22 — Crédito adicional suplementar por excesso de arrecadação (Onda 2, Lei 4.320
// art. 43, II). O excesso de arrecadação de uma fonte (arrecadado − previsto) lastreia a
// suplementação de uma dotação; o crédito nunca ultrapassa o excesso ainda não utilizado
// daquela fonte no exercício. Suplementa o destino e registra o crédito. Reusa budget.*.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200).optional(),
});

export const getSupplementaryCredits = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    const credits = await query<{
      id: string;
      exercicio: number;
      destino_id: string;
      fonte_recurso: string;
      valor: string;
      tipo: string;
      data_referencia: string;
    }>(
      `select id, exercicio, destino_id, fonte_recurso, valor::text, tipo,
         data_referencia::text
       from public.budget_supplementary_credits
       where tenant_id = $1 and ($2::int is null or exercicio = $2)
       order by data_referencia desc, created_at desc`,
      [data.tenant_id, data.exercicio ?? null],
    );
    return {
      credits,
      canManage: access.permissions.includes("budget.manage"),
    };
  });

const OpenInput = z.object({
  tenant_id: z.string().uuid(),
  destino_id: z.string().uuid(),
  fonte_recurso: z.string().trim().min(1).max(60),
  valor: z.number().positive().max(1_000_000_000_000),
  data_referencia: z.string().date(),
  justificativa: z.string().trim().min(5).max(2000),
});

// Abre o crédito suplementar lastreado no excesso de arrecadação da fonte.
export const openSupplementaryCredit = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => OpenInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const destino = (
        await client.query<{ exercicio: number; status: string }>(
          `select exercicio, status from public.budget_appropriations
           where id=$1 and tenant_id=$2 for update`,
          [data.destino_id, data.tenant_id],
        )
      ).rows[0];
      if (!destino) throw new Error("Dotação de destino não encontrada");
      if (destino.status !== "ativa")
        throw new Error("Só uma dotação ativa pode ser suplementada");

      // Excesso de arrecadação da fonte no exercício (arrecadado − previsto).
      const receita = (
        await client.query<{ previsto: string; arrecadado: string }>(
          `select coalesce(sum(valor_previsto),0)::text as previsto,
             coalesce(sum(valor_arrecadado),0)::text as arrecadado
           from public.budget_revenues
           where tenant_id=$1 and exercicio=$2 and fonte_recurso=$3`,
          [data.tenant_id, destino.exercicio, data.fonte_recurso],
        )
      ).rows[0];
      const excesso = Number(receita.arrecadado) - Number(receita.previsto);

      // Excesso já utilizado por créditos suplementares anteriores da mesma fonte.
      const utilizado = Number(
        (
          await client.query<{ total: string }>(
            `select coalesce(sum(valor),0)::text as total
             from public.budget_supplementary_credits
             where tenant_id=$1 and exercicio=$2 and fonte_recurso=$3`,
            [data.tenant_id, destino.exercicio, data.fonte_recurso],
          )
        ).rows[0].total,
      );
      const disponivel = Number((excesso - utilizado).toFixed(2));
      if (data.valor > disponivel)
        throw new Error(
          `Excesso de arrecadação insuficiente (disponível ${disponivel.toFixed(2)}) para o crédito (${data.valor.toFixed(2)})`,
        );

      // Suplementa a dotação de destino.
      await client.query(
        `update public.budget_appropriations
         set valor_orcado = valor_orcado + $3, updated_at = now()
         where id=$1 and tenant_id=$2`,
        [data.destino_id, data.tenant_id, data.valor],
      );
      const id = randomUUID();
      await client.query(
        `insert into public.budget_supplementary_credits
           (id, tenant_id, exercicio, destino_id, fonte_recurso, valor,
            justificativa, data_referencia, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          destino.exercicio,
          data.destino_id,
          data.fonte_recurso,
          data.valor,
          data.justificativa,
          data.data_referencia,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "credito_suplementar",
        resource: "budget_supplementary_credits",
        recordId: id,
        after: { fonte_recurso: data.fonte_recurso, valor: data.valor },
      });
      return {
        id,
        valor: data.valor,
        excesso_disponivel: Number((disponivel - data.valor).toFixed(2)),
      };
    });
  });
