// O4-09 — Execução fiscal (Onda 4, Lei 6.830). Registra o ajuizamento da cobrança de
// uma CDA ativa: número do processo (informado), data, valor ajuizado (fixado da CDA) e
// o andamento (ajuizada → suspensa → extinta/quitada). É o REGISTRO interno — não
// peticiona nem integra ao Judiciário. Reusa taxes.*. Uma execução por CDA.
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

const GetInput = z.object({ tenant_id: z.string().uuid() });

export const getFiscalExecutions = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const executions = await query<{
      id: string;
      cda_id: string;
      cda_numero: string;
      numero_processo: string;
      data_ajuizamento: string;
      valor_ajuizado: string;
      status: string;
    }>(
      `select e.id, e.cda_id, c.numero::text as cda_numero, e.numero_processo,
         e.data_ajuizamento::text, e.valor_ajuizado::text, e.status
       from public.fiscal_executions e
       join public.active_debt_certificates c on c.id = e.cda_id
       where e.tenant_id = $1
       order by e.data_ajuizamento desc`,
      [data.tenant_id],
    );
    return {
      executions,
      canManage: access.permissions.includes("taxes.manage"),
    };
  });

const FileInput = z.object({
  tenant_id: z.string().uuid(),
  cda_id: z.string().uuid(),
  numero_processo: z.string().trim().min(1).max(60),
  data_ajuizamento: z.string().date(),
});

// Ajuíza a execução fiscal da CDA ativa. Fixa o valor ajuizado do valor inscrito na
// CDA; uma execução por CDA (unique + guarda de estado).
export const fileFiscalExecution = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => FileInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const cda = (
        await client.query<{ valor_inscrito: string; status: string }>(
          `select valor_inscrito::text, status
           from public.active_debt_certificates
           where id=$1 and tenant_id=$2 for update`,
          [data.cda_id, data.tenant_id],
        )
      ).rows[0];
      if (!cda) throw new Error("CDA não encontrada");
      if (cda.status !== "ativa")
        throw new Error("Só uma CDA ativa pode ser ajuizada");

      const dup = await client.query(
        `select id from public.fiscal_executions
         where tenant_id=$1 and cda_id=$2`,
        [data.tenant_id, data.cda_id],
      );
      if (dup.rows.length) throw new Error("CDA já possui execução fiscal");

      const valorAjuizado = Number(cda.valor_inscrito);
      const id = randomUUID();
      await client.query(
        `insert into public.fiscal_executions
           (id, tenant_id, cda_id, numero_processo, data_ajuizamento,
            valor_ajuizado, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          data.tenant_id,
          data.cda_id,
          data.numero_processo,
          data.data_ajuizamento,
          valorAjuizado,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "file_fiscal_execution",
        resource: "fiscal_executions",
        recordId: id,
        after: { numero_processo: data.numero_processo, valorAjuizado },
      });
      return { id, valor_ajuizado: valorAjuizado };
    });
  });

const UpdateStatusInput = z.object({
  tenant_id: z.string().uuid(),
  execution_id: z.string().uuid(),
  status: z.enum(["suspensa", "extinta", "quitada", "ajuizada"]),
  observacao: z.string().trim().max(500).optional(),
});

// Atualiza o andamento da execução. Uma execução extinta/quitada é terminal.
export const updateFiscalExecutionStatus = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => UpdateStatusInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const exec = (
        await client.query<{ status: string; cda_id: string }>(
          `select status, cda_id from public.fiscal_executions
           where id=$1 and tenant_id=$2 for update`,
          [data.execution_id, data.tenant_id],
        )
      ).rows[0];
      if (!exec) throw new Error("Execução fiscal não encontrada");
      if (exec.status === "extinta" || exec.status === "quitada")
        throw new Error("Execução encerrada não muda de andamento");
      // Quitar EXIGE crédito satisfeito (saldo ≤ 0) — mesma regra de
      // settleActiveDebtCertificate. Sem isto o andamento "quitada" apagava a
      // dívida do estoque em cobrança sem um centavo em tax_payments. Validado
      // ANTES de gravar o andamento.
      if (data.status === "quitada") {
        const credito = (
          await client.query<{ saldo: string }>(
            `select (c.valor_lancado - c.valor_pago)::text as saldo
             from public.active_debt_certificates cda
             join public.tax_credits c
               on c.id = cda.credit_id and c.tenant_id = cda.tenant_id
             where cda.id=$1 and cda.tenant_id=$2
             for update of c`,
            [exec.cda_id, data.tenant_id],
          )
        ).rows[0];
        if (!credito) throw new Error("Crédito da CDA não encontrado");
        if (Number(credito.saldo) > 0)
          throw new Error(
            `A execução só quita com o crédito satisfeito (saldo devedor de ${Number(credito.saldo).toFixed(2)}). Registre a arrecadação antes, ou encerre como extinta.`,
          );
      }
      await client.query(
        `update public.fiscal_executions
         set status=$3, observacao=coalesce($4, observacao), updated_at=now()
         where id=$1 and tenant_id=$2`,
        [
          data.execution_id,
          data.tenant_id,
          data.status,
          data.observacao ?? null,
        ],
      );
      // Satisfeito o crédito, a execução quitada baixa a CDA: sai do estoque em
      // cobrança (o saldo consolidado só soma CDAs ativas).
      if (data.status === "quitada") {
        await client.query(
          `update public.active_debt_certificates set status='quitada'
           where id=$1 and tenant_id=$2 and status='ativa'`,
          [exec.cda_id, data.tenant_id],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "update_fiscal_execution",
        resource: "fiscal_executions",
        recordId: data.execution_id,
        after: { status: data.status },
      });
      return { id: data.execution_id, status: data.status };
    });
  });
