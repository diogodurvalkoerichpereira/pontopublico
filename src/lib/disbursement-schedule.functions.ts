// O2-19 — Cronograma de desembolso / programação financeira (Onda 2, Lei 4.320
// art. 47-50). O ente programa cotas mensais de desembolso por fonte de recurso; o
// cronograma confronta, mês a mês, o programado com o realizado (despesa efetivamente
// paga no mês). Reusa budget.* (alçada do orçamento).
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
  exercicio: z.number().int().min(2000).max(2200),
});

export const getDisbursementSchedule = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");

    // Programado por mês (soma das cotas de todas as fontes).
    const programadoRows = await query<{ mes: number; programado: string }>(
      `select mes, coalesce(sum(valor_programado),0)::text as programado
       from public.disbursement_schedules
       where tenant_id = $1 and exercicio = $2
       group by mes`,
      [data.tenant_id, data.exercicio],
    );

    // Realizado por mês: despesa paga (mês do pagamento), empenhos não anulados.
    const realizadoRows = await query<{ mes: number; realizado: string }>(
      `select extract(month from pago_em)::int as mes,
         coalesce(sum(valor),0)::text as realizado
       from public.budget_commitments
       where tenant_id = $1 and exercicio = $2 and status = 'pago'
         and pago_em is not null
       group by extract(month from pago_em)`,
      [data.tenant_id, data.exercicio],
    );

    const programadoDe = (mes: number) =>
      Number(
        programadoRows.find((r) => Number(r.mes) === mes)?.programado ?? 0,
      );
    const realizadoDe = (mes: number) =>
      Number(realizadoRows.find((r) => Number(r.mes) === mes)?.realizado ?? 0);
    const n2 = (v: number) => Number(v.toFixed(2));

    const meses = Array.from({ length: 12 }, (_, i) => {
      const mes = i + 1;
      const programado = programadoDe(mes);
      const realizado = realizadoDe(mes);
      return {
        mes,
        programado: n2(programado),
        realizado: n2(realizado),
        // Saldo da cota: programado − realizado (negativo = estouro da cota).
        saldo: n2(programado - realizado),
      };
    });

    const totais = meses.reduce(
      (acc, m) => ({
        programado: acc.programado + m.programado,
        realizado: acc.realizado + m.realizado,
      }),
      { programado: 0, realizado: 0 },
    );

    return {
      exercicio: data.exercicio,
      meses,
      totais: {
        programado: n2(totais.programado),
        realizado: n2(totais.realizado),
        saldo: n2(totais.programado - totais.realizado),
      },
    };
  });

const SaveInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
  mes: z.number().int().min(1).max(12),
  fonte_recurso: z.string().trim().min(1).max(60),
  valor_programado: z.number().min(0).max(1_000_000_000_000),
});

// Define (ou substitui) a cota mensal de desembolso de uma fonte no exercício.
export const saveDisbursementQuota = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const id = randomUUID();
      await client.query(
        `insert into public.disbursement_schedules
           (id, tenant_id, exercicio, mes, fonte_recurso, valor_programado, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, exercicio, mes, fonte_recurso) do update
           set valor_programado = excluded.valor_programado, updated_at = now()`,
        [
          id,
          data.tenant_id,
          data.exercicio,
          data.mes,
          data.fonte_recurso,
          data.valor_programado,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "programar",
        resource: "disbursement_schedules",
        recordId: id,
        after: {
          exercicio: data.exercicio,
          mes: data.mes,
          fonte_recurso: data.fonte_recurso,
          valor_programado: data.valor_programado,
        },
      });
      return { ok: true };
    });
  });
