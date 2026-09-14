// O3-07 — Termo aditivo de contrato (Onda 3, Lei 14.133/2021, art. 125). O aditivo
// altera o contrato vigente: acréscimo/supressão de valor (limitado a 25% do valor
// ORIGINAL, acumulado entre aditivos) e/ou prorrogação de vigência. Numeração
// sequencial por contrato. Reusa contracts.*.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseInput } from "./input-validation";
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
  .validator((data: unknown) => parseInput(GetInput, data))
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
      status: string;
      motivo_cancelamento: string | null;
    }>(
      `select id, numero, tipo, valor_acrescimo::text, nova_vigencia_fim::text,
         justificativa, data_aditivo::text, status, motivo_cancelamento
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
  .validator((data: unknown) => parseInput(RegisterInput, data))
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
               where contract_id=$1 and tenant_id=$2 and status='vigente'`,
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
            nova_vigencia_fim, justificativa, data_aditivo, created_by,
            vigencia_anterior)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
          // Só faz sentido para aditivo de prazo; é o único jeito de voltar,
          // porque a regra só aceita prorrogar e a data anterior não é
          // recuperável por cálculo.
          alteraPrazo ? contract.vigencia_fim : null,
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

const CancelAmendmentInput = z.object({
  tenant_id: z.string().uuid(),
  amendment_id: z.string().uuid(),
  motivo: z.string().trim().min(5).max(500),
});

// O3-14 — Cancela um termo aditivo, devolvendo o contrato ao estado anterior.
//
// Sem isso o aditivo era de mão única: um valor digitado errado queimava parte do
// limite de 25% do art. 125 para sempre, e "registrar outro compensando" não
// resolve — o limite é sobre o acumulado, então o erro e o estorno somariam DUAS
// vezes contra o teto. Uma data errada era pior ainda: a regra só aceita
// prorrogar, então não havia caminho de volta.
//
// Só o ÚLTIMO aditivo vigente é cancelável. Cancelar um do meio deixaria os
// posteriores apoiados num estado que deixou de existir — a vigência que eles
// prorrogaram, o valor sobre o qual foram calculados.
export const cancelContractAmendment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(CancelAmendmentInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const aditivo = (
        await client.query<{
          contract_id: string;
          numero: number;
          tipo: string;
          status: string;
          valor_acrescimo: string;
          vigencia_anterior: string | null;
        }>(
          `select contract_id, numero, tipo, status, valor_acrescimo::text,
             vigencia_anterior::text
           from public.contract_amendments
           where id=$1 and tenant_id=$2 for update`,
          [data.amendment_id, data.tenant_id],
        )
      ).rows[0];
      if (!aditivo) throw new Error("Termo aditivo não encontrado");
      if (aditivo.status === "cancelado")
        throw new Error("Este termo aditivo já está cancelado");

      const contract = (
        await client.query<{
          valor_total: string;
          valor_empenhado: string;
          status: string;
        }>(
          `select valor_total::text, valor_empenhado::text, status
           from public.procurement_contracts
           where id=$1 and tenant_id=$2 for update`,
          [aditivo.contract_id, data.tenant_id],
        )
      ).rows[0];
      if (!contract) throw new Error("Contrato não encontrado");
      if (contract.status !== "vigente")
        throw new Error("Só um contrato vigente tem aditivo cancelável");

      const ultimo = (
        await client.query<{ numero: number }>(
          `select max(numero) as numero from public.contract_amendments
           where contract_id=$1 and tenant_id=$2 and status='vigente'`,
          [aditivo.contract_id, data.tenant_id],
        )
      ).rows[0];
      if (Number(ultimo?.numero) !== Number(aditivo.numero))
        throw new Error(
          `Só o último termo aditivo vigente (nº ${ultimo?.numero}) pode ser cancelado: ` +
            `os posteriores foram calculados sobre o estado que este criou.`,
        );

      const alteraValor = aditivo.tipo !== "prazo";
      const alteraPrazo = aditivo.tipo !== "valor";
      const novoTotal = alteraValor
        ? Number(
            (
              Number(contract.valor_total) - Number(aditivo.valor_acrescimo)
            ).toFixed(2),
          )
        : Number(contract.valor_total);
      if (novoTotal <= 0)
        throw new Error("O cancelamento zeraria o valor do contrato");
      // Um acréscimo já empenhado não pode ser desfeito: o empenho ficaria acima
      // do contrato. Anule o empenho antes.
      if (novoTotal < Number(contract.valor_empenhado))
        throw new Error(
          `O cancelamento deixaria o contrato (${novoTotal.toFixed(2)}) abaixo do já ` +
            `empenhado (${Number(contract.valor_empenhado).toFixed(2)}). Anule o empenho antes.`,
        );

      await client.query(
        `update public.contract_amendments
         set status='cancelado', cancelado_em=now(), cancelado_por=$3,
             motivo_cancelamento=$4
         where id=$1 and tenant_id=$2`,
        [data.amendment_id, data.tenant_id, context.userId, data.motivo],
      );
      await client.query(
        `update public.procurement_contracts
         set valor_total=$3,
             vigencia_fim=case when $4::date is not null then $4::date else vigencia_fim end,
             updated_at=now()
         where id=$1 and tenant_id=$2`,
        [
          aditivo.contract_id,
          data.tenant_id,
          novoTotal,
          alteraPrazo ? aditivo.vigencia_anterior : null,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "cancelar_aditivo",
        resource: "contract_amendments",
        recordId: data.amendment_id,
        after: {
          numero: aditivo.numero,
          valor_total: novoTotal,
          motivo: data.motivo,
        },
      });
      return {
        id: data.amendment_id,
        numero: aditivo.numero,
        valor_total: novoTotal,
      };
    });
  });
