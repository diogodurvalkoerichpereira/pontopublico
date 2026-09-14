// O3-14 — Medição / recebimento de contrato (Onda 3, Lei 14.133 art. 140). A cada entrega
// o ente mede o contrato, acumulando o valor executado; a execução acumulada nunca passa
// do valor empenhado (só se liquida o que foi empenhado). Numeração sequencial por
// contrato. Reusa contracts.*.
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

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  contract_id: z.string().uuid().optional(),
});

export const getContractMeasurements = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(GetInput, data))
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
  .validator((data: unknown) => parseInput(RecordInput, data))
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
  .validator((data: unknown) => parseInput(AttestInput, data))
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

const CancelInput = z.object({
  tenant_id: z.string().uuid(),
  measurement_id: z.string().uuid(),
  motivo: z.string().trim().max(500).optional(),
});

// O3-14c — Cancela (glosa) uma medição **provisória** rejeitada na verificação (Lei
// 14.133 art. 140): a medição vai a 'cancelado' (terminal) e o valor volta ao
// executado do contrato, liberando o saldo executável. Definitiva (já atestada,
// autorizou pagamento) não cancela; cancelada não recancela. Reusa contracts.manage.
export const cancelContractMeasurement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(CancelInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const medicao = (
        await client.query<{
          recebimento: string;
          numero: number;
          valor: string;
          contract_id: string;
        }>(
          `select recebimento, numero, valor::text, contract_id
           from public.contract_measurements
           where id=$1 and tenant_id=$2 for update`,
          [data.measurement_id, data.tenant_id],
        )
      ).rows[0];
      if (!medicao) throw new Error("Medição não encontrada");
      if (medicao.recebimento !== "provisorio")
        throw new Error(
          "Só uma medição provisória pode ser cancelada (definitiva autorizou pagamento)",
        );
      // Devolve o valor ao saldo executável do contrato (trava o contrato).
      const contract = (
        await client.query<{ valor_executado: string }>(
          `select valor_executado::text from public.procurement_contracts
           where id=$1 and tenant_id=$2 for update`,
          [medicao.contract_id, data.tenant_id],
        )
      ).rows[0];
      if (!contract) throw new Error("Contrato da medição não encontrado");
      const novoExecutado = Number(
        (Number(contract.valor_executado) - Number(medicao.valor)).toFixed(2),
      );
      await client.query(
        `update public.contract_measurements set recebimento='cancelado'
         where id=$1 and tenant_id=$2`,
        [data.measurement_id, data.tenant_id],
      );
      await client.query(
        `update public.procurement_contracts
         set valor_executado=$3, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [medicao.contract_id, data.tenant_id, novoExecutado],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "cancelar_medicao",
        resource: "contract_measurements",
        recordId: data.measurement_id,
        before: { recebimento: "provisorio" },
        after: {
          recebimento: "cancelado",
          valor_executado: novoExecutado,
          motivo: data.motivo ?? null,
        },
      });
      return {
        id: data.measurement_id,
        recebimento: "cancelado",
        valor_executado: novoExecutado,
      };
    });
  });

const SummaryInput = z.object({
  tenant_id: z.string().uuid(),
  contract_id: z.string().uuid(),
});

// O3-14d — Execução físico-financeira do contrato. Consolida, para um contrato, o valor
// contratado/empenhado/executado e o saldo executável (contratado − executado), e reparte
// as medições por situação: **definitivo** (atestado, autoriza pagamento), **provisório**
// (medido, aguardando atesto) e **glosado** (cancelado, devolveu o saldo). Dá a visão de
// quanto já pode pagar × quanto ainda depende de verificação — que a lista de medições, uma
// a uma, não resume. Read-only, reusa contracts.read.
export const getContractMeasurementsSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SummaryInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const contract = (
      await query<{
        valor_total: string;
        valor_empenhado: string;
        valor_executado: string;
      }>(
        `select valor_total::text, valor_empenhado::text, valor_executado::text
         from public.procurement_contracts where id=$1 and tenant_id=$2`,
        [data.contract_id, data.tenant_id],
      )
    )[0];
    if (!contract) throw new Error("Contrato não encontrado");
    const agg = (
      await query<{
        definitivo: string;
        provisorio: string;
        glosado: string;
        q_definitivo: string;
        q_provisorio: string;
        q_glosado: string;
      }>(
        `select
           coalesce(sum(valor) filter (where recebimento='definitivo'),0)::text as definitivo,
           coalesce(sum(valor) filter (where recebimento='provisorio'),0)::text as provisorio,
           coalesce(sum(valor) filter (where recebimento='cancelado'),0)::text as glosado,
           count(*) filter (where recebimento='definitivo')::text as q_definitivo,
           count(*) filter (where recebimento='provisorio')::text as q_provisorio,
           count(*) filter (where recebimento='cancelado')::text as q_glosado
         from public.contract_measurements
         where tenant_id=$1 and contract_id=$2`,
        [data.tenant_id, data.contract_id],
      )
    )[0];
    const round2 = (v: number) => Number(v.toFixed(2));
    const valorTotal = round2(Number(contract.valor_total));
    const executado = round2(Number(contract.valor_executado));
    return {
      valor_total: valorTotal,
      valor_empenhado: round2(Number(contract.valor_empenhado)),
      valor_executado: executado,
      saldo_a_executar: round2(valorTotal - executado),
      medicoes: {
        // Atestado autoriza pagamento; provisório aguarda verificação.
        definitivo: round2(Number(agg.definitivo)),
        provisorio: round2(Number(agg.provisorio)),
        glosado: round2(Number(agg.glosado)),
        q_definitivo: Number(agg.q_definitivo),
        q_provisorio: Number(agg.q_provisorio),
        q_glosado: Number(agg.q_glosado),
      },
    };
  });
