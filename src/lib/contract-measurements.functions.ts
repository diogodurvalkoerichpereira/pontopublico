// O3-14 — Medição / recebimento de contrato (Onda 3, Lei 14.133 art. 140). A cada entrega
// o ente mede o contrato, acumulando o valor executado; a execução acumulada nunca passa
// do valor empenhado (só se liquida o que foi empenhado). Numeração sequencial por
// contrato. Reusa contracts.*.
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
  contract_id: z.string().uuid().optional(),
});

export const getContractMeasurements = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const measurements = await query<{
      id: string;
      contract_id: string;
      numero: number;
      competencia: string;
      valor: string;
      descricao: string;
      data_medicao: string;
      recebimento: string;
    }>(
      `select id, contract_id, numero, competencia, valor::text, descricao,
         data_medicao::text, recebimento
       from public.contract_measurements
       where tenant_id = $1 and ($2::uuid is null or contract_id = $2)
       order by contract_id, numero`,
      [data.tenant_id, data.contract_id ?? null],
    );
    return {
      measurements,
      canManage: access.permissions.includes("contracts.manage"),
    };
  });

const RecordInput = z.object({
  tenant_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  competencia: z.string().trim().min(4).max(20),
  valor: z.number().positive().max(1_000_000_000_000),
  descricao: z.string().trim().min(3).max(500),
  data_medicao: z.string().date(),
  recebimento: z.enum(["provisorio", "definitivo"]).default("provisorio"),
});

// Registra a medição do contrato vigente. A execução acumulada nunca passa do empenhado.
export const recordContractMeasurement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => RecordInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const contract = (
        await client.query<{
          status: string;
          valor_empenhado: string;
          valor_executado: string;
        }>(
          `select status, valor_empenhado::text, valor_executado::text
           from public.procurement_contracts
           where id=$1 and tenant_id=$2 for update`,
          [data.contract_id, data.tenant_id],
        )
      ).rows[0];
      if (!contract) throw new Error("Contrato não encontrado");
      if (contract.status !== "vigente")
        throw new Error("Só um contrato vigente pode ser medido");

      const empenhado = Number(contract.valor_empenhado);
      const executado = Number(contract.valor_executado);
      // Só se mede/liquida o que foi empenhado (Lei 4.320).
      if (executado + data.valor > empenhado + 0.005)
        throw new Error(
          `Medição excede o valor empenhado (executado ${executado.toFixed(2)} + ${data.valor.toFixed(2)} > empenhado ${empenhado.toFixed(2)})`,
        );

      // Numeração sequencial (contrato já travado FOR UPDATE — serializa).
      const numero =
        Number(
          (
            await client.query<{ n: string }>(
              `select coalesce(max(numero),0)::text as n
               from public.contract_measurements
               where tenant_id=$1 and contract_id=$2`,
              [data.tenant_id, data.contract_id],
            )
          ).rows[0].n,
        ) + 1;

      const novoExecutado = Number((executado + data.valor).toFixed(2));
      const id = randomUUID();
      await client.query(
        `insert into public.contract_measurements
           (id, tenant_id, contract_id, numero, competencia, valor, descricao,
            data_medicao, recebimento, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          data.tenant_id,
          data.contract_id,
          numero,
          data.competencia,
          data.valor,
          data.descricao,
          data.data_medicao,
          data.recebimento,
          context.userId,
        ],
      );
      await client.query(
        `update public.procurement_contracts
         set valor_executado=$3, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.contract_id, data.tenant_id, novoExecutado],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "medir_contrato",
        resource: "contract_measurements",
        recordId: id,
        after: { numero, valor: data.valor, valor_executado: novoExecutado },
      });
      return { id, numero, valor_executado: novoExecutado };
    });
  });

const AttestInput = z.object({
  tenant_id: z.string().uuid(),
  measurement_id: z.string().uuid(),
  observacao: z.string().trim().max(500).optional(),
});

// O3-14b — Recebimento definitivo da medição (Lei 14.133 art. 140, I). O recebimento
// **provisório** é o registro da entrega; o **definitivo** é o atesto, após a verificação
// de qualidade/quantidade, que autoriza o pagamento. Só uma medição provisória pode ser
// atestada; definitiva é terminal (não reabre). Reusa contracts.manage.
export const attestContractMeasurement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => AttestInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const medicao = (
        await client.query<{ recebimento: string; numero: number }>(
          `select recebimento, numero from public.contract_measurements
           where id=$1 and tenant_id=$2 for update`,
          [data.measurement_id, data.tenant_id],
        )
      ).rows[0];
      if (!medicao) throw new Error("Medição não encontrada");
      if (medicao.recebimento === "definitivo")
        throw new Error("Medição já recebida em definitivo");
      await client.query(
        `update public.contract_measurements set recebimento='definitivo'
         where id=$1 and tenant_id=$2`,
        [data.measurement_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "receber_definitivo_medicao",
        resource: "contract_measurements",
        recordId: data.measurement_id,
        before: { recebimento: medicao.recebimento },
        after: {
          recebimento: "definitivo",
          observacao: data.observacao ?? null,
        },
      });
      return { id: data.measurement_id, recebimento: "definitivo" };
    });
  });
