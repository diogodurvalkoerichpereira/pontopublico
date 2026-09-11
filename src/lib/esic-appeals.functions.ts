// O5-06 — Recurso de e-SIC (Onda 5, LAI art. 15). Da negativa de acesso (pedido
// indeferido) cabe recurso de 1ª instância; improvido, cabe 2ª instância. Recurso
// provido reabre o pedido para cumprimento (status volta a 'recebido'). Reusa
// protocol.*. Um recurso por pedido/instância.
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
  request_id: z.string().uuid().optional(),
});

export const getEsicAppeals = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");
    const appeals = await query<{
      id: string;
      request_id: string;
      instancia: number;
      fundamento: string;
      data_recurso: string;
      status: string;
      decisao: string | null;
    }>(
      `select id, request_id, instancia, fundamento, data_recurso::text,
         status, decisao
       from public.esic_appeals
       where tenant_id = $1 and ($2::uuid is null or request_id = $2)
       order by data_recurso desc, instancia`,
      [data.tenant_id, data.request_id ?? null],
    );
    return {
      appeals,
      canManage: access.permissions.includes("protocol.manage"),
    };
  });

const FileInput = z.object({
  tenant_id: z.string().uuid(),
  request_id: z.string().uuid(),
  instancia: z.union([z.literal(1), z.literal(2)]),
  fundamento: z.string().trim().min(3).max(2000),
  data_recurso: z.string().date(),
});

// Interpõe o recurso. 1ª instância exige pedido indeferido; 2ª instância exige o
// recurso de 1ª instância improvido. Um recurso por pedido/instância.
export const fileEsicAppeal = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => FileInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    return withTransaction(async (client) => {
      const req = (
        await client.query<{ status: string }>(
          `select status from public.esic_requests
           where id=$1 and tenant_id=$2 for update`,
          [data.request_id, data.tenant_id],
        )
      ).rows[0];
      if (!req) throw new Error("Pedido de e-SIC não encontrado");

      if (data.instancia === 1) {
        if (req.status !== "indeferido")
          throw new Error("Só um pedido indeferido admite recurso");
      } else {
        const first = (
          await client.query<{ status: string }>(
            `select status from public.esic_appeals
             where tenant_id=$1 and request_id=$2 and instancia=1`,
            [data.tenant_id, data.request_id],
          )
        ).rows[0];
        if (!first || first.status !== "improvido")
          throw new Error(
            "2ª instância exige recurso de 1ª instância improvido",
          );
      }

      const dup = await client.query(
        `select id from public.esic_appeals
         where tenant_id=$1 and request_id=$2 and instancia=$3`,
        [data.tenant_id, data.request_id, data.instancia],
      );
      if (dup.rows.length)
        throw new Error("Já há recurso nesta instância para o pedido");

      const id = randomUUID();
      await client.query(
        `insert into public.esic_appeals
           (id, tenant_id, request_id, instancia, fundamento, data_recurso, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          data.tenant_id,
          data.request_id,
          data.instancia,
          data.fundamento,
          data.data_recurso,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "file_esic_appeal",
        resource: "esic_appeals",
        recordId: id,
        after: { instancia: data.instancia },
      });
      return { id, instancia: data.instancia };
    });
  });

const DecideInput = z.object({
  tenant_id: z.string().uuid(),
  appeal_id: z.string().uuid(),
  decisao: z.enum(["provido", "improvido"]),
  justificativa: z.string().trim().min(3).max(2000),
  data_decisao: z.string().date(),
});

// Decide o recurso pendente. Provido reabre o pedido (status volta a 'recebido') para
// cumprimento; improvido mantém o indeferimento.
export const decideEsicAppeal = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => DecideInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    return withTransaction(async (client) => {
      const appeal = (
        await client.query<{ status: string; request_id: string }>(
          `select status, request_id from public.esic_appeals
           where id=$1 and tenant_id=$2 for update`,
          [data.appeal_id, data.tenant_id],
        )
      ).rows[0];
      if (!appeal) throw new Error("Recurso não encontrado");
      if (appeal.status !== "pendente") throw new Error("Recurso já decidido");
      await client.query(
        `update public.esic_appeals
         set status=$3, decisao=$4, decidido_em=$5::date, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [
          data.appeal_id,
          data.tenant_id,
          data.decisao,
          data.justificativa,
          data.data_decisao,
        ],
      );
      // Provido: reabre o pedido para cumprimento.
      if (data.decisao === "provido") {
        await client.query(
          `update public.esic_requests set status='recebido', updated_at=now()
           where id=$1 and tenant_id=$2`,
          [appeal.request_id, data.tenant_id],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "decide_esic_appeal",
        resource: "esic_appeals",
        recordId: data.appeal_id,
        after: { decisao: data.decisao },
      });
      return { id: data.appeal_id, decisao: data.decisao };
    });
  });
