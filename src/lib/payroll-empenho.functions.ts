import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const round2 = (value: number) => Number(value.toFixed(2));

const Tenant = z.object({ tenant_id: z.string().uuid() });

export const getPayrollEmpenhoRequests = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => Tenant.parse(v))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.cycles.read");
    const [requests, lines] = await Promise.all([
      query<{
        id: string;
        cycle_id: string;
        reference_month: string;
        fonte_recurso: string;
        base_earnings: number;
        total_amount: number;
        status: string;
        created_at: string;
      }>(
        `select r.id,r.cycle_id,r.reference_month::text,r.fonte_recurso,
           r.base_earnings,r.total_amount,r.status,r.created_at::text
         from public.payroll_empenho_requests r
         where r.tenant_id=$1 order by r.reference_month desc,r.created_at desc`,
        [data.tenant_id],
      ),
      query<{
        id: string;
        request_id: string;
        natureza_despesa: string;
        description: string;
        amount: number;
      }>(
        `select l.id,l.request_id,l.natureza_despesa,l.description,l.amount
         from public.payroll_empenho_request_lines l
         where l.tenant_id=$1 order by l.natureza_despesa`,
        [data.tenant_id],
      ),
    ]);
    return {
      requests,
      lines,
      canManage: access.permissions.includes("payroll.cycles.close"),
    };
  });

const EmitInput = z.object({
  tenant_id: z.string().uuid(),
  cycle_id: z.string().uuid(),
  fonte_recurso: z.string().trim().min(1).max(120),
  lines: z
    .array(
      z.object({
        // Natureza da despesa (PCASP), ex.: "3.1.90.11.00".
        natureza_despesa: z
          .string()
          .trim()
          .regex(/^[0-9.]{4,20}$/, "Natureza de despesa inválida"),
        description: z.string().trim().min(3).max(200),
        amount: z.number().positive().max(1_000_000_000),
      }),
    )
    .min(1)
    .max(200),
});

// Emite a requisicao de empenho de uma folha mensal FECHADA: a despesa bruta de
// pessoal (proventos) classificada por natureza (PCASP). As linhas TEM de somar a
// despesa bruta do ciclo — o empenho cobre a folha inteira, sem sobra nem falta.
// Retencoes sao extra-orcamentarias (nao entram). Interface para a Onda 2; nao e
// empenho homologado no SIAFIC.
export const emitPayrollEmpenhoRequest = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => EmitInput.parse(v))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.cycles.close");
    return withTransaction(async (client) => {
      const cycle = (
        await client.query<{
          reference_month: string;
          cycle_type: string;
          status: string;
          total_earnings: string;
        }>(
          `select reference_month::text,cycle_type,status,total_earnings::text
           from public.payroll_cycles where id=$1 and tenant_id=$2 for update`,
          [data.cycle_id, data.tenant_id],
        )
      ).rows[0];
      if (!cycle) throw new Error("Folha não encontrada");
      if (cycle.cycle_type !== "mensal")
        throw new Error("Só a folha mensal emite requisição de empenho");
      if (cycle.status !== "fechada")
        throw new Error("A folha precisa estar fechada para empenhar");

      const existing = await client.query(
        `select id from public.payroll_empenho_requests where cycle_id=$1`,
        [data.cycle_id],
      );
      if (existing.rows.length)
        throw new Error("Esta folha já tem requisição de empenho");

      const base = round2(Number(cycle.total_earnings));
      const totalLines = round2(
        data.lines.reduce((sum, line) => sum + line.amount, 0),
      );
      if (totalLines !== base)
        throw new Error(
          `As linhas do empenho devem somar a despesa bruta de pessoal (${base.toFixed(2)}); somam ${totalLines.toFixed(2)}`,
        );

      const requestId = randomUUID();
      const memory = {
        cycle_id: data.cycle_id,
        reference_month: cycle.reference_month,
        base_earnings: base,
        fonte_recurso: data.fonte_recurso,
        lines: data.lines.map((line) => ({
          natureza_despesa: line.natureza_despesa,
          description: line.description,
          amount: round2(line.amount),
        })),
        note: "Requisicao de empenho da folha (PCASP). Retencoes sao extra-orcamentarias. Nao homologado no SIAFIC.",
      };
      await client.query(
        `insert into public.payroll_empenho_requests
           (id,tenant_id,cycle_id,reference_month,fonte_recurso,base_earnings,
            total_amount,status,memory,result_checksum,created_by)
         values ($1,$2,$3,$4,$5,$6,$7,'emitida',$8::jsonb,$9,$10)`,
        [
          requestId,
          data.tenant_id,
          data.cycle_id,
          cycle.reference_month,
          data.fonte_recurso,
          base,
          totalLines,
          JSON.stringify(memory),
          digest(memory),
          context.userId,
        ],
      );
      for (const line of data.lines) {
        await client.query(
          `insert into public.payroll_empenho_request_lines
             (tenant_id,request_id,natureza_despesa,description,amount)
           values ($1,$2,$3,$4,$5)`,
          [
            data.tenant_id,
            requestId,
            line.natureza_despesa,
            line.description,
            round2(line.amount),
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "emit_empenho_request",
        resource: "payroll_empenho_requests",
        recordId: requestId,
        after: {
          cycle_id: data.cycle_id,
          reference_month: cycle.reference_month,
          total_amount: totalLines,
          lines: data.lines.length,
        },
      });
      return { id: requestId, total: totalLines, lines: data.lines.length };
    });
  });
