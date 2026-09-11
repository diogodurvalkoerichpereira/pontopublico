// O3-08 — Itens do contrato (Onda 3, Lei 14.133). Detalha o contrato em linhas de
// material/serviço, cada uma com quantidade e preço unitário; o valor da linha é
// quantidade × preço. A soma dos itens não pode exceder o valor total do contrato.
// Numeração de linha sequencial por contrato. Reusa contracts.*.
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
  contract_id: z.string().uuid(),
});

export const getContractItems = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const items = await query<{
      id: string;
      numero: number;
      descricao: string;
      unidade: string;
      quantidade: string;
      preco_unitario: string;
      valor_total: string;
    }>(
      `select id, numero, descricao, unidade, quantidade::text,
         preco_unitario::text, valor_total::text
       from public.contract_items
       where tenant_id = $1 and contract_id = $2
       order by numero`,
      [data.tenant_id, data.contract_id],
    );
    return {
      items,
      canManage: access.permissions.includes("contracts.manage"),
    };
  });

const AddInput = z.object({
  tenant_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  descricao: z.string().trim().min(2).max(300),
  unidade: z.string().trim().min(1).max(20),
  quantidade: z.number().positive().max(100_000_000),
  preco_unitario: z.number().positive().max(1_000_000_000),
});

// Adiciona uma linha ao contrato; a soma dos itens não pode passar do valor total.
export const addContractItem = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => AddInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    const valor = Number((data.quantidade * data.preco_unitario).toFixed(2));
    return withTransaction(async (client) => {
      const contract = (
        await client.query<{ valor_total: string; status: string }>(
          `select valor_total::text, status from public.procurement_contracts
           where id=$1 and tenant_id=$2 for update`,
          [data.contract_id, data.tenant_id],
        )
      ).rows[0];
      if (!contract) throw new Error("Contrato não encontrado");
      if (contract.status !== "vigente")
        throw new Error("Só um contrato vigente recebe itens");
      const somaItens = Number(
        (
          await client.query<{ soma: string }>(
            `select coalesce(sum(valor_total),0)::text as soma
             from public.contract_items
             where contract_id=$1 and tenant_id=$2`,
            [data.contract_id, data.tenant_id],
          )
        ).rows[0].soma,
      );
      if (somaItens + valor > Number(contract.valor_total) + 0.005)
        throw new Error(
          `A soma dos itens (${(somaItens + valor).toFixed(2)}) excederia o valor do contrato (${Number(contract.valor_total).toFixed(2)})`,
        );
      const numero = Number(
        (
          await client.query<{ n: string }>(
            `select coalesce(max(numero),0)+1 as n from public.contract_items
             where contract_id=$1 and tenant_id=$2`,
            [data.contract_id, data.tenant_id],
          )
        ).rows[0].n,
      );
      const id = randomUUID();
      await client.query(
        `insert into public.contract_items
           (id, tenant_id, contract_id, numero, descricao, unidade, quantidade,
            preco_unitario, valor_total, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          data.tenant_id,
          data.contract_id,
          numero,
          data.descricao,
          data.unidade,
          data.quantidade,
          data.preco_unitario,
          valor,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "add_item",
        resource: "contract_items",
        recordId: id,
        after: { numero, valor_total: valor },
      });
      return { id, numero, valor_total: valor };
    });
  });
