// O1-09 — Consignações em folha e margem consignável (Onda 1, Lei 10.820/2003 e
// regime do servidor). Descontos consignados (empréstimo, sindicato, plano de
// saúde, pensão) têm de caber na MARGEM CONSIGNÁVEL: teto legal (padrão 35% da
// remuneração de base) sobre a soma das parcelas ativas. A margem é conferida na
// inclusão — uma consignação nova só entra se couber. Reusa people.*.
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

// Margem consignável legal padrão: 35% da remuneração de base.
const MARGEM_PADRAO = 0.35;

const MarginInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  margem_percent: z.number().positive().max(1).optional(),
});

// Consulta a margem: remuneração de base, teto, comprometido e disponível, com as
// consignações ativas.
export const getConsignmentMargin = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => MarginInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const link = (
      await query<{ base_salary: string | null }>(
        `select base_salary::text from public.employment_links
         where id=$1 and tenant_id=$2`,
        [data.employment_link_id, data.tenant_id],
      )
    )[0];
    if (!link) throw new Error("Vínculo não encontrado");
    const ativas = await query<{
      id: string;
      tipo: string;
      consignatario: string;
      valor_parcela: string;
      parcelas_total: number;
      parcelas_pagas: number;
    }>(
      `select id, tipo, consignatario, valor_parcela::text, parcelas_total,
         parcelas_pagas
       from public.payroll_consignments
       where tenant_id=$1 and employment_link_id=$2 and status='ativa'
       order by created_at`,
      [data.tenant_id, data.employment_link_id],
    );
    const base = Number(link.base_salary ?? 0);
    const margem = Number(
      (base * (data.margem_percent ?? MARGEM_PADRAO)).toFixed(2),
    );
    const comprometido = Number(
      ativas.reduce((s, c) => s + Number(c.valor_parcela), 0).toFixed(2),
    );
    return {
      base_salary: base,
      margem,
      comprometido,
      disponivel: Number((margem - comprometido).toFixed(2)),
      consignments: ativas,
      canManage: access.permissions.includes("people.manage"),
    };
  });

const RegisterInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  tipo: z.enum(["emprestimo", "sindicato", "plano_saude", "pensao", "outro"]),
  consignatario: z.string().trim().min(2).max(200),
  valor_parcela: z.number().positive().max(1_000_000),
  parcelas_total: z.number().int().min(1).max(120),
  inicio: z.string().date(),
  margem_percent: z.number().positive().max(1).optional(),
});

// Inclui uma consignação: só entra se couber na margem consignável disponível.
export const registerConsignment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => RegisterInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.manage");
    return withTransaction(async (client) => {
      const link = (
        await client.query<{ base_salary: string | null; status: string }>(
          `select base_salary::text, status from public.employment_links
           where id=$1 and tenant_id=$2 for update`,
          [data.employment_link_id, data.tenant_id],
        )
      ).rows[0];
      if (!link) throw new Error("Vínculo não encontrado");
      if (link.status === "desligado")
        throw new Error("Vínculo desligado não recebe consignação");
      const base = Number(link.base_salary ?? 0);
      if (base <= 0)
        throw new Error(
          "Vínculo sem remuneração de base para calcular a margem",
        );
      const margem = Number(
        (base * (data.margem_percent ?? MARGEM_PADRAO)).toFixed(2),
      );
      const comprometido = Number(
        (
          await client.query<{ soma: string }>(
            `select coalesce(sum(valor_parcela),0)::text as soma
             from public.payroll_consignments
             where tenant_id=$1 and employment_link_id=$2 and status='ativa'`,
            [data.tenant_id, data.employment_link_id],
          )
        ).rows[0].soma,
      );
      const disponivel = Number((margem - comprometido).toFixed(2));
      if (data.valor_parcela > disponivel + 0.005)
        throw new Error(
          `Parcela (${data.valor_parcela.toFixed(2)}) excede a margem consignável disponível (${disponivel.toFixed(2)})`,
        );
      const id = randomUUID();
      await client.query(
        `insert into public.payroll_consignments
           (id, tenant_id, employment_link_id, tipo, consignatario, valor_parcela,
            parcelas_total, inicio, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          data.employment_link_id,
          data.tipo,
          data.consignatario,
          data.valor_parcela,
          data.parcelas_total,
          data.inicio,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "consignar",
        resource: "payroll_consignments",
        recordId: id,
        after: {
          tipo: data.tipo,
          valor_parcela: data.valor_parcela,
          parcelas_total: data.parcelas_total,
        },
      });
      return {
        id,
        margem,
        comprometido: Number((comprometido + data.valor_parcela).toFixed(2)),
        disponivel: Number((disponivel - data.valor_parcela).toFixed(2)),
      };
    });
  });

const CancelInput = z.object({
  tenant_id: z.string().uuid(),
  consignment_id: z.string().uuid(),
});

// Cancela uma consignação ativa, liberando a margem. Só uma ativa cancela.
export const cancelConsignment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CancelInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.manage");
    return withTransaction(async (client) => {
      const c = (
        await client.query<{ status: string }>(
          `select status from public.payroll_consignments
           where id=$1 and tenant_id=$2 for update`,
          [data.consignment_id, data.tenant_id],
        )
      ).rows[0];
      if (!c) throw new Error("Consignação não encontrada");
      if (c.status !== "ativa")
        throw new Error("Só uma consignação ativa pode ser cancelada");
      await client.query(
        `update public.payroll_consignments set status='cancelada', updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.consignment_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "cancelar",
        resource: "payroll_consignments",
        recordId: data.consignment_id,
        after: { status: "cancelada" },
      });
      return { id: data.consignment_id, status: "cancelada" };
    });
  });
