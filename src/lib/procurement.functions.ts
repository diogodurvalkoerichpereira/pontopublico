// O3-06 — Licitação / processo licitatório (Lei 14.133). O certame que antecede o
// contrato: abertura → homologada / fracassada / deserta / revogada. Reusa
// contracts.*.
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
  ano: z.number().int().min(2000).max(2200).optional(),
});

export const getProcurementProcesses = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const processes = await query<{
      id: string;
      numero: string;
      ano: number;
      modalidade: string;
      objeto: string;
      valor_estimado: string;
      status: string;
      abertura: string;
      homologado_em: string | null;
    }>(
      `select id, numero, ano, modalidade, objeto, valor_estimado::text, status,
         abertura::text, homologado_em::text
       from public.procurement_processes
       where tenant_id = $1 and ($2::int is null or ano = $2)
       order by ano desc, numero`,
      [data.tenant_id, data.ano ?? null],
    );
    return {
      processes,
      canManage: access.permissions.includes("contracts.manage"),
    };
  });

const OpenInput = z.object({
  tenant_id: z.string().uuid(),
  numero: z.string().trim().min(1).max(40),
  ano: z.number().int().min(2000).max(2200),
  modalidade: z.enum([
    "pregao",
    "concorrencia",
    "concurso",
    "leilao",
    "dialogo_competitivo",
    "dispensa",
    "inexigibilidade",
    "credenciamento",
  ]),
  objeto: z.string().trim().min(3).max(500),
  valor_estimado: z.number().positive().max(1_000_000_000_000),
  abertura: z.string().date(),
});

export const openProcurementProcess = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => OpenInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    const id = randomUUID();
    await withTransaction(async (client) => {
      const dup = await client.query(
        `select id from public.procurement_processes
         where tenant_id=$1 and ano=$2 and lower(numero)=lower($3)`,
        [data.tenant_id, data.ano, data.numero],
      );
      if (dup.rows.length)
        throw new Error("Já existe licitação com este número no ano");
      await client.query(
        `insert into public.procurement_processes
           (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado,
            abertura, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          data.numero,
          data.ano,
          data.modalidade,
          data.objeto,
          data.valor_estimado,
          data.abertura,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "open",
        resource: "procurement_processes",
        recordId: id,
        after: { numero: data.numero, ano: data.ano },
      });
    });
    return { id };
  });

const TransitionInput = z.object({
  tenant_id: z.string().uuid(),
  process_id: z.string().uuid(),
  desfecho: z.enum(["homologada", "fracassada", "deserta", "revogada"]),
  data_referencia: z.string().date(),
});

// Encerra o certame com um desfecho. Só uma licitação aberta transita.
export const transitionProcurementProcess = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TransitionInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const process = (
        await client.query<{ status: string }>(
          `select status from public.procurement_processes
           where id=$1 and tenant_id=$2 for update`,
          [data.process_id, data.tenant_id],
        )
      ).rows[0];
      if (!process) throw new Error("Licitação não encontrada");
      if (process.status !== "aberta")
        throw new Error("Só uma licitação aberta pode ser encerrada");
      await client.query(
        `update public.procurement_processes
         set status=$3,
             homologado_em=case when $3='homologada' then $4::date else homologado_em end,
             updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.process_id, data.tenant_id, data.desfecho, data.data_referencia],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.desfecho,
        resource: "procurement_processes",
        recordId: data.process_id,
        after: { desfecho: data.desfecho },
      });
      return { id: data.process_id, status: data.desfecho };
    });
  });
