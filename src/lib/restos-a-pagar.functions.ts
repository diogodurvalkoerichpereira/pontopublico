// O2-09 — Restos a pagar (Onda 2, Lei 4.320, art. 36). No encerramento do
// exercício, os empenhos não pagos são inscritos: PROCESSADOS (liquidados, só
// falta pagar) e NÃO PROCESSADOS (empenhados, ainda não liquidados). Empenho pago
// ou anulado não inscreve; cada empenho inscreve uma só vez. Pagar o resto quita o
// empenho de origem. Reusa budget.*.
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
  exercicio_origem: z.number().int().min(2000).max(2200).optional(),
});

export const getRestosAPagar = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    const restos = await query<{
      id: string;
      commitment_id: string;
      exercicio_origem: number;
      tipo: string;
      valor: string;
      inscrito_em: string;
      status: string;
      pago_em: string | null;
      numero: string;
      credor: string;
    }>(
      `select r.id, r.commitment_id, r.exercicio_origem, r.tipo, r.valor::text,
         r.inscrito_em::text, r.status, r.pago_em::text,
         c.numero::text, c.credor
       from public.restos_a_pagar r
       join public.budget_commitments c on c.id = r.commitment_id
       where r.tenant_id = $1
         and ($2::int is null or r.exercicio_origem = $2)
       order by r.exercicio_origem desc, c.numero`,
      [data.tenant_id, data.exercicio_origem ?? null],
    );
    return {
      restos,
      canManage: access.permissions.includes("budget.manage"),
    };
  });

const InscribeInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
  inscrito_em: z.string().date(),
});

// Inscreve em restos a pagar todos os empenhos não pagos do exercício ainda não
// inscritos. Idempotente: reexecutar não duplica.
export const inscribeRestosAPagar = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => InscribeInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const candidatos = (
        await client.query<{
          id: string;
          status: string;
          valor: string;
        }>(
          `select c.id, c.status, c.valor::text
           from public.budget_commitments c
           where c.tenant_id = $1 and c.exercicio = $2
             and c.status in ('empenhado', 'liquidado')
             and not exists (
               select 1 from public.restos_a_pagar r
               where r.commitment_id = c.id and r.tenant_id = c.tenant_id
             )
           for update`,
          [data.tenant_id, data.exercicio],
        )
      ).rows;
      let processados = 0;
      let naoProcessados = 0;
      let valorTotal = 0;
      for (const c of candidatos) {
        const tipo = c.status === "liquidado" ? "processado" : "nao_processado";
        if (tipo === "processado") processados += 1;
        else naoProcessados += 1;
        valorTotal = Number((valorTotal + Number(c.valor)).toFixed(2));
        await client.query(
          `insert into public.restos_a_pagar
             (id, tenant_id, commitment_id, exercicio_origem, tipo, valor,
              inscrito_em, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            data.tenant_id,
            c.id,
            data.exercicio,
            tipo,
            Number(c.valor),
            data.inscrito_em,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "inscrever_restos",
        resource: "restos_a_pagar",
        recordId: data.tenant_id,
        after: {
          exercicio: data.exercicio,
          processados,
          nao_processados: naoProcessados,
          valor_total: valorTotal,
        },
      });
      return {
        inscritos: candidatos.length,
        processados,
        nao_processados: naoProcessados,
        valor_total: valorTotal,
      };
    });
  });

const PayInput = z.object({
  tenant_id: z.string().uuid(),
  resto_id: z.string().uuid(),
  data_pagamento: z.string().date(),
});

// Paga um resto a pagar inscrito: quita o empenho de origem (status 'pago').
export const payRestoAPagar = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => PayInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const resto = (
        await client.query<{ commitment_id: string; status: string }>(
          `select commitment_id, status from public.restos_a_pagar
           where id=$1 and tenant_id=$2 for update`,
          [data.resto_id, data.tenant_id],
        )
      ).rows[0];
      if (!resto) throw new Error("Resto a pagar não encontrado");
      if (resto.status !== "inscrito")
        throw new Error("Só um resto inscrito pode ser pago");
      await client.query(
        `update public.restos_a_pagar
         set status='pago', pago_em=$3::date, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.resto_id, data.tenant_id, data.data_pagamento],
      );
      await client.query(
        `update public.budget_commitments set status='pago'
         where id=$1 and tenant_id=$2`,
        [resto.commitment_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "pagar_resto",
        resource: "restos_a_pagar",
        recordId: data.resto_id,
        after: { data_pagamento: data.data_pagamento },
      });
      return { id: data.resto_id, status: "pago" };
    });
  });
