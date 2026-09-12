// O2-13 — Crédito adicional por remanejamento (Onda 2, Lei 4.320 art. 42-43).
// Transfere dotação entre classificações no mesmo exercício: anula parte do orçado
// da origem e suplementa o destino. A origem nunca fica abaixo do já empenhado; as
// duas dotações têm de ser do mesmo exercício e estar ativas. Reusa budget.*.
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

export const getBudgetCreditMovements = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    const movements = await query<{
      id: string;
      exercicio: number;
      origem_id: string;
      destino_id: string;
      valor: string;
      justificativa: string;
      data_referencia: string;
    }>(
      `select id, exercicio, origem_id, destino_id, valor::text, justificativa,
         data_referencia::text
       from public.budget_credit_movements
       where tenant_id = $1 and ($2::int is null or exercicio = $2)
       order by data_referencia desc, created_at desc`,
      [data.tenant_id, data.exercicio ?? null],
    );
    return {
      movements,
      canManage: access.permissions.includes("budget.manage"),
    };
  });

const TransferInput = z.object({
  tenant_id: z.string().uuid(),
  origem_id: z.string().uuid(),
  destino_id: z.string().uuid(),
  valor: z.number().positive().max(1_000_000_000_000),
  data_referencia: z.string().date(),
  justificativa: z.string().trim().min(5).max(2000),
});

// Remaneja crédito: anula na origem, suplementa no destino, atômico.
export const transferBudgetCredit = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TransferInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    if (data.origem_id === data.destino_id)
      throw new Error("Origem e destino devem ser dotações diferentes");
    // Trava as duas dotações em ordem estável (por id) para evitar deadlock.
    const [first, second] = [data.origem_id, data.destino_id].sort();
    return withTransaction(async (client) => {
      await client.query(
        `select id from public.budget_appropriations
         where tenant_id=$1 and id in ($2,$3) order by id for update`,
        [data.tenant_id, first, second],
      );
      const origem = (
        await client.query<{
          exercicio: number;
          valor_orcado: string;
          valor_empenhado: string;
          status: string;
        }>(
          `select exercicio, valor_orcado::text, valor_empenhado::text, status
           from public.budget_appropriations where id=$1 and tenant_id=$2`,
          [data.origem_id, data.tenant_id],
        )
      ).rows[0];
      const destino = (
        await client.query<{ exercicio: number; status: string }>(
          `select exercicio, status
           from public.budget_appropriations where id=$1 and tenant_id=$2`,
          [data.destino_id, data.tenant_id],
        )
      ).rows[0];
      if (!origem || !destino) throw new Error("Dotação não encontrada");
      if (origem.status !== "ativa" || destino.status !== "ativa")
        throw new Error("Só dotações ativas podem ser remanejadas");
      if (origem.exercicio !== destino.exercicio)
        throw new Error("O remanejamento é dentro do mesmo exercício");
      const orcadoOrigem = Number(origem.valor_orcado);
      const empenhadoOrigem = Number(origem.valor_empenhado);
      if (orcadoOrigem - data.valor < empenhadoOrigem - 0.005)
        throw new Error(
          `A origem ficaria abaixo do empenhado (orçado ${orcadoOrigem.toFixed(2)} − ${data.valor.toFixed(2)} < empenhado ${empenhadoOrigem.toFixed(2)})`,
        );
      await client.query(
        `update public.budget_appropriations
         set valor_orcado = valor_orcado - $3, updated_at = now()
         where id=$1 and tenant_id=$2`,
        [data.origem_id, data.tenant_id, data.valor],
      );
      await client.query(
        `update public.budget_appropriations
         set valor_orcado = valor_orcado + $3, updated_at = now()
         where id=$1 and tenant_id=$2`,
        [data.destino_id, data.tenant_id, data.valor],
      );
      const id = randomUUID();
      await client.query(
        `insert into public.budget_credit_movements
           (id, tenant_id, exercicio, origem_id, destino_id, valor, justificativa,
            data_referencia, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          origem.exercicio,
          data.origem_id,
          data.destino_id,
          data.valor,
          data.justificativa,
          data.data_referencia,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "remanejamento",
        resource: "budget_credit_movements",
        recordId: id,
        after: {
          origem_id: data.origem_id,
          destino_id: data.destino_id,
          valor: data.valor,
        },
      });
      return {
        id,
        origem_orcado: Number((orcadoOrigem - data.valor).toFixed(2)),
      };
    });
  });
