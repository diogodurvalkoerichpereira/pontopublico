// O3-07 — Termo aditivo de contrato (Onda 3, Lei 14.133/2021, art. 125). O aditivo
// altera o contrato vigente: acréscimo/supressão de valor (limitado a 25% do valor
// ORIGINAL, acumulado entre aditivos) e/ou prorrogação de vigência. Numeração
// sequencial por contrato. Reusa contracts.*.
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

// Limite legal de alteração de valor (art. 125): 25% para acréscimos ou supressões.
const LIMITE_ALTERACAO = 0.25;

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  contract_id: z.string().uuid(),
});

export const getContractAmendments = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const amendments = await query<{
      id: string;
      numero: number;
      tipo: string;
      valor_acrescimo: string;
      nova_vigencia_fim: string | null;
      justificativa: string;
      data_aditivo: string;
    }>(
      `select id, numero, tipo, valor_acrescimo::text, nova_vigencia_fim::text,
         justificativa, data_aditivo::text
       from public.contract_amendments
       where tenant_id = $1 and contract_id = $2
       order by numero`,
      [data.tenant_id, data.contract_id],
    );
    return {
      amendments,
      canManage: access.permissions.includes("contracts.manage"),
    };
  });

const RegisterInput = z
  .object({
    tenant_id: z.string().uuid(),
    contract_id: z.string().uuid(),
    tipo: z.enum(["valor", "prazo", "valor_prazo"]),
    // Positivo = acréscimo; negativo = supressão. Zero só quando tipo='prazo'.
    valor_acrescimo: z
      .number()
      .min(-1_000_000_000)
      .max(1_000_000_000)
      .default(0),
    nova_vigencia_fim: z.string().date().nullable().optional(),
    justificativa: z.string().trim().min(5).max(2000),
    data_aditivo: z.string().date(),
  })
  .refine((v) => v.tipo === "prazo" || v.valor_acrescimo !== 0, {
    message: "Aditivo de valor exige valor_acrescimo diferente de zero",
  })
  .refine((v) => v.tipo === "valor" || v.nova_vigencia_fim != null, {
    message: "Aditivo de prazo exige nova_vigencia_fim",
  });

export const registerContractAmendment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => RegisterInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    const alteraValor = data.tipo !== "prazo";
    const alteraPrazo = data.tipo !== "valor";
    return withTransaction(async (client) => {
      const contract = (
        await client.query<{
          valor_total: string;
          valor_empenhado: string;
          vigencia_fim: string;
          status: string;
        }>(
          `select valor_total::text, valor_empenhado::text, vigencia_fim::text, status
           from public.procurement_contracts
           where id=$1 and tenant_id=$2 for update`,
          [data.contract_id, data.tenant_id],
        )
      ).rows[0];
      if (!contract) throw new Error("Contrato não encontrado");
      if (contract.status !== "vigente")
        throw new Error("Só um contrato vigente pode ser aditado");

      const valorTotal = Number(contract.valor_total);
      let novoTotal = valorTotal;
      if (alteraValor) {
        const somaAnteriores = Number(
          (
            await client.query<{ soma: string }>(
              `select coalesce(sum(valor_acrescimo),0)::text as soma
               from public.contract_amendments
               where contract_id=$1 and tenant_id=$2`,
              [data.contract_id, data.tenant_id],
            )
          ).rows[0].soma,
        );
        // Valor original = total atual menos os acréscimos já aplicados.
        const valorOriginal = Number((valorTotal - somaAnteriores).toFixed(2));
        const acumulado = Number(
          (somaAnteriores + data.valor_acrescimo).toFixed(2),
        );
        const limite = Number((valorOriginal * LIMITE_ALTERACAO).toFixed(2));
        if (Math.abs(acumulado) > limite + 0.005)
          throw new Error(
            `Alteração acumulada de valor (${acumulado.toFixed(2)}) excede o limite de 25% do valor original (${limite.toFixed(2)})`,
          );
        novoTotal = Number((valorTotal + data.valor_acrescimo).toFixed(2));
        if (novoTotal <= 0)
          throw new Error("Valor do contrato ficaria zerado ou negativo");
        if (novoTotal < Number(contract.valor_empenhado))
          throw new Error(
            "Supressão deixaria o valor abaixo do já empenhado no contrato",
          );
      }

      if (alteraPrazo) {
        if (
          data.nova_vigencia_fim &&
          data.nova_vigencia_fim <= contract.vigencia_fim
        )
          throw new Error(
            "A nova vigência deve ser posterior à vigência atual",
          );
      }

      const numero = Number(
        (
          await client.query<{ n: string }>(
            // O contrato já está travado FOR UPDATE acima, serializando os
            // aditivos deste contrato — a numeração não precisa de lock próprio.
            `select coalesce(max(numero),0)+1 as n
             from public.contract_amendments
             where contract_id=$1 and tenant_id=$2`,
            [data.contract_id, data.tenant_id],
          )
        ).rows[0].n,
      );
      const id = randomUUID();
      await client.query(
        `insert into public.contract_amendments
           (id, tenant_id, contract_id, numero, tipo, valor_acrescimo,
            nova_vigencia_fim, justificativa, data_aditivo, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          data.tenant_id,
          data.contract_id,
          numero,
          data.tipo,
          alteraValor ? data.valor_acrescimo : 0,
          alteraPrazo ? (data.nova_vigencia_fim ?? null) : null,
          data.justificativa,
          data.data_aditivo,
          context.userId,
        ],
      );
      await client.query(
        `update public.procurement_contracts
         set valor_total=$3,
             vigencia_fim=case when $4::date is not null then $4::date else vigencia_fim end,
             updated_at=now()
         where id=$1 and tenant_id=$2`,
        [
          data.contract_id,
          data.tenant_id,
          novoTotal,
          alteraPrazo ? (data.nova_vigencia_fim ?? null) : null,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "aditar",
        resource: "contract_amendments",
        recordId: id,
        after: { numero, tipo: data.tipo, valor_total: novoTotal },
      });
      return { id, numero, valor_total: novoTotal };
    });
  });
