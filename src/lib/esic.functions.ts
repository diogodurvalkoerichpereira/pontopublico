// O5-04 — e-SIC: pedidos de acesso à informação (Onda 5, LAI Lei 12.527/2011). O
// cidadão pede informação; o ente responde em até 20 dias, prorrogáveis por mais
// 10 (art. 11, §1º/§2º). Numeração sequencial por ano (contador travado FOR
// UPDATE), prazo calculado e o ciclo recebido→(prorrogado)→respondido/indeferido.
// Reusa as permissões de protocolo (protocol.*).
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

// Prazo legal da LAI: 20 dias para responder; prorrogação de mais 10 (art. 11).
const PRAZO_LAI_DIAS = 20;
const PRORROGACAO_DIAS = 10;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  ano: z.number().int().min(2000).max(2200).optional(),
});

const SummaryInput = z.object({
  tenant_id: z.string().uuid(),
  data_referencia: z.string().date().optional(),
});

// O5-04b — Painel de prazos do e-SIC (LAI). Consolida a contagem por situação, destaca os
// pedidos EM ABERTO (recebido/prorrogado) com prazo de resposta vencido e a tempestividade
// dos já respondidos/indeferidos: dentro do prazo quando respondido até o prazo, fora do
// prazo quando depois. Reusa protocol.read.
export const getEsicSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SummaryInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");
    const ref = data.data_referencia ?? new Date().toISOString().slice(0, 10);
    const row = (
      await query<{
        recebido: string;
        prorrogado: string;
        respondido: string;
        indeferido: string;
        vencidos: string;
        respondidos_no_prazo: string;
        respondidos_fora_prazo: string;
        total: string;
      }>(
        `select
           count(*) filter (where status='recebido')::text as recebido,
           count(*) filter (where status='prorrogado')::text as prorrogado,
           count(*) filter (where status='respondido')::text as respondido,
           count(*) filter (where status='indeferido')::text as indeferido,
           count(*) filter (
             where status in ('recebido','prorrogado') and prazo_resposta < $2::date
           )::text as vencidos,
           count(*) filter (
             where respondido_em is not null and respondido_em <= prazo_resposta
           )::text as respondidos_no_prazo,
           count(*) filter (
             where respondido_em is not null and respondido_em > prazo_resposta
           )::text as respondidos_fora_prazo,
           count(*)::text as total
         from public.esic_requests where tenant_id = $1`,
        [data.tenant_id, ref],
      )
    )[0];
    return {
      data_referencia: ref,
      porStatus: {
        recebido: Number(row.recebido),
        prorrogado: Number(row.prorrogado),
        respondido: Number(row.respondido),
        indeferido: Number(row.indeferido),
      },
      vencidos: Number(row.vencidos),
      respondidosNoPrazo: Number(row.respondidos_no_prazo),
      respondidosForaPrazo: Number(row.respondidos_fora_prazo),
      total: Number(row.total),
    };
  });

export const getEsicRequests = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(GetInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");
    const requests = await query<{
      id: string;
      ano: number;
      numero: string;
      solicitante: string;
      anonimo: boolean;
      status: string;
      prazo_resposta: string;
      prorrogado: boolean;
      respondido_em: string | null;
      created_at: string;
    }>(
      `select id, ano, numero::text, solicitante, anonimo, status,
         prazo_resposta::text, prorrogado, respondido_em::text, created_at::text
       from public.esic_requests
       where tenant_id = $1 and ($2::int is null or ano = $2)
       order by ano desc, numero desc`,
      [data.tenant_id, data.ano ?? null],
    );
    return {
      requests,
      canManage: access.permissions.includes("protocol.manage"),
    };
  });

const OpenInput = z.object({
  tenant_id: z.string().uuid(),
  solicitante: z.string().trim().min(2).max(200),
  anonimo: z.boolean().default(false),
  pedido: z.string().trim().min(3).max(5000),
  aberto_em: z.string().date(),
});

// Abre um pedido: número sequencial por ano e prazo de 20 dias (LAI).
export const openEsicRequest = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(OpenInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    const ano = Number(data.aberto_em.slice(0, 4));
    const prazoResposta = addDays(data.aberto_em, PRAZO_LAI_DIAS);
    return withTransaction(async (client) => {
      await client.query(
        `insert into public.esic_counters (tenant_id, ano)
         values ($1, $2) on conflict do nothing`,
        [data.tenant_id, ano],
      );
      const counter = (
        await client.query<{ last_numero: string }>(
          `select last_numero::text from public.esic_counters
           where tenant_id=$1 and ano=$2 for update`,
          [data.tenant_id, ano],
        )
      ).rows[0];
      const numero = Number(counter.last_numero) + 1;
      await client.query(
        `update public.esic_counters set last_numero=$3
         where tenant_id=$1 and ano=$2`,
        [data.tenant_id, ano, numero],
      );
      const id = randomUUID();
      await client.query(
        `insert into public.esic_requests
           (id, tenant_id, ano, numero, solicitante, anonimo, pedido,
            prazo_resposta, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          ano,
          numero,
          data.solicitante,
          data.anonimo,
          data.pedido,
          prazoResposta,
          data.anonimo ? null : context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "open",
        resource: "esic_requests",
        recordId: id,
        after: { ano, numero },
      });
      return { id, numero, ano, prazo_resposta: prazoResposta };
    });
  });

const ExtendInput = z.object({
  tenant_id: z.string().uuid(),
  request_id: z.string().uuid(),
});

// Prorroga o prazo por mais 10 dias (art. 11, §2º). Só uma vez, só em aberto.
export const extendEsicRequest = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(ExtendInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    return withTransaction(async (client) => {
      const req = (
        await client.query<{
          status: string;
          prorrogado: boolean;
          prazo_resposta: string;
        }>(
          `select status, prorrogado, prazo_resposta::text
           from public.esic_requests where id=$1 and tenant_id=$2 for update`,
          [data.request_id, data.tenant_id],
        )
      ).rows[0];
      if (!req) throw new Error("Pedido e-SIC não encontrado");
      // Só 'recebido' prorroga: a prorrogação já move o status para 'prorrogado',
      // então uma segunda tentativa cai aqui (prorrogação única, art. 11, §2º).
      if (req.status !== "recebido")
        throw new Error("Só um pedido recebido pode ser prorrogado uma vez");
      const novoPrazo = addDays(req.prazo_resposta, PRORROGACAO_DIAS);
      await client.query(
        `update public.esic_requests
         set status='prorrogado', prorrogado=true, prazo_resposta=$3::date,
             updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.request_id, data.tenant_id, novoPrazo],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "extend",
        resource: "esic_requests",
        recordId: data.request_id,
        after: { prazo_resposta: novoPrazo },
      });
      return { id: data.request_id, prazo_resposta: novoPrazo };
    });
  });

const RespondInput = z.object({
  tenant_id: z.string().uuid(),
  request_id: z.string().uuid(),
  desfecho: z.enum(["respondido", "indeferido"]),
  resposta: z.string().trim().min(3).max(5000),
  respondido_em: z.string().date(),
});

// Responde ou indefere o pedido. Só um pedido em aberto (recebido/prorrogado).
export const respondEsicRequest = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(RespondInput, data))
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
      if (!req) throw new Error("Pedido e-SIC não encontrado");
      if (req.status !== "recebido" && req.status !== "prorrogado")
        throw new Error("Só um pedido em aberto pode ser respondido");
      await client.query(
        `update public.esic_requests
         set status=$3, resposta=$4, respondido_em=$5::date, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [
          data.request_id,
          data.tenant_id,
          data.desfecho,
          data.resposta,
          data.respondido_em,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.desfecho,
        resource: "esic_requests",
        recordId: data.request_id,
        after: { respondido_em: data.respondido_em },
      });
      return { id: data.request_id, status: data.desfecho };
    });
  });
