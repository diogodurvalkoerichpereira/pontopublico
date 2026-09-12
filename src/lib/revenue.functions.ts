// O2-08 — Receita: previsão (LOA) e arrecadação (Lei 4.320). Espelha o padrão de
// budget.functions. Reusa budget.read/manage. A arrecadação incrementa o
// valor_arrecadado da receita, atômico.
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

export const getBudgetRevenues = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    const revenues = await query<{
      id: string;
      exercicio: number;
      natureza_receita: string;
      fonte_recurso: string;
      descricao: string;
      valor_previsto: string;
      valor_arrecadado: string;
      saldo: string;
      status: "ativa" | "encerrada";
    }>(
      `select id, exercicio, natureza_receita, fonte_recurso, descricao,
         valor_previsto::text, valor_arrecadado::text,
         (valor_previsto - valor_arrecadado)::text as saldo, status
       from public.budget_revenues
       where tenant_id = $1 and ($2::int is null or exercicio = $2)
       order by exercicio desc, natureza_receita`,
      [data.tenant_id, data.exercicio ?? null],
    );
    const totais = revenues.reduce(
      (acc, r) => ({
        previsto: acc.previsto + Number(r.valor_previsto),
        arrecadado: acc.arrecadado + Number(r.valor_arrecadado),
      }),
      { previsto: 0, arrecadado: 0 },
    );
    return {
      revenues,
      totais: {
        previsto: Number(totais.previsto.toFixed(2)),
        arrecadado: Number(totais.arrecadado.toFixed(2)),
      },
      canManage: access.permissions.includes("budget.manage"),
    };
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
  natureza_receita: z
    .string()
    .trim()
    .regex(/^[0-9.]{4,20}$/, "Natureza de receita inválida"),
  fonte_recurso: z.string().trim().min(1).max(60),
  descricao: z.string().trim().min(2).max(200),
  valor_previsto: z.number().min(0).max(1_000_000_000_000),
  status: z.enum(["ativa", "encerrada"]).default("ativa"),
});

export const saveBudgetRevenue = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        const before = (
          await client.query(
            "select valor_arrecadado::text from public.budget_revenues where id=$1 and tenant_id=$2",
            [data.id, data.tenant_id],
          )
        ).rows[0] as { valor_arrecadado: string } | undefined;
        if (!before) throw new Error("Receita não encontrada");
        if (data.valor_previsto < Number(before.valor_arrecadado))
          throw new Error("Previsão não pode ser menor que o já arrecadado");
        await client.query(
          `update public.budget_revenues set exercicio=$3, natureza_receita=$4,
             fonte_recurso=$5, descricao=$6, valor_previsto=$7, status=$8,
             updated_at=now()
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.exercicio,
            data.natureza_receita,
            data.fonte_recurso,
            data.descricao,
            data.valor_previsto,
            data.status,
          ],
        );
      } else {
        await client.query(
          `insert into public.budget_revenues
             (id, tenant_id, exercicio, natureza_receita, fonte_recurso,
              descricao, valor_previsto, status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            data.tenant_id,
            data.exercicio,
            data.natureza_receita,
            data.fonte_recurso,
            data.descricao,
            data.valor_previsto,
            data.status,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "budget_revenues",
        recordId: id,
        after: data,
      });
    });
    return { id };
  });

const CollectInput = z.object({
  tenant_id: z.string().uuid(),
  revenue_id: z.string().uuid(),
  data_arrecadacao: z.string().date(),
  valor: z.number().positive().max(1_000_000_000_000),
  historico: z.string().trim().min(3).max(500),
});

// Registra a arrecadação e incrementa o valor_arrecadado da receita (atômico).
export const recordRevenueCollection = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CollectInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const revenue = (
        await client.query<{ status: string }>(
          `select status from public.budget_revenues
           where id=$1 and tenant_id=$2 for update`,
          [data.revenue_id, data.tenant_id],
        )
      ).rows[0];
      if (!revenue) throw new Error("Receita não encontrada");
      if (revenue.status !== "ativa")
        throw new Error("Receita encerrada não arrecada");
      const id = randomUUID();
      await client.query(
        `insert into public.revenue_collections
           (id, tenant_id, revenue_id, data_arrecadacao, valor, historico, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          data.tenant_id,
          data.revenue_id,
          data.data_arrecadacao,
          data.valor,
          data.historico,
          context.userId,
        ],
      );
      await client.query(
        `update public.budget_revenues
         set valor_arrecadado = valor_arrecadado + $3, updated_at = now()
         where id=$1 and tenant_id=$2`,
        [data.revenue_id, data.tenant_id, data.valor],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "collect",
        resource: "revenue_collections",
        recordId: id,
        after: { revenue_id: data.revenue_id, valor: data.valor },
      });
      return { id };
    });
  });
