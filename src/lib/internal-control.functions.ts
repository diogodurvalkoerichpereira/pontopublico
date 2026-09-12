// O5-05 — Controle interno (Onda 5, CF art. 74, Lei 4.320, LRF). A unidade de
// controle interno registra apontamentos com recomendação, responsável e prazo, e
// acompanha a implementação: aberto → em_implementacao → implementado/
// nao_implementado. Numeração sequencial por ano (contador travado). Reusa
// analytics.*.
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
  status: z
    .enum(["aberto", "em_implementacao", "implementado", "nao_implementado"])
    .optional(),
});

export const getInternalControlFindings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "analytics.read");
    const findings = await query<{
      id: string;
      ano: number;
      numero: string;
      area: string;
      responsavel: string;
      prazo: string;
      status: string;
      concluido_em: string | null;
    }>(
      `select id, ano, numero::text, area, responsavel, prazo::text, status,
         concluido_em::text
       from public.internal_control_findings
       where tenant_id = $1
         and ($2::int is null or ano = $2)
         and ($3::text is null or status = $3)
       order by ano desc, numero desc`,
      [data.tenant_id, data.ano ?? null, data.status ?? null],
    );
    return {
      findings,
      canManage: access.permissions.includes("analytics.manage"),
    };
  });

const SummaryInput = z.object({
  tenant_id: z.string().uuid(),
  data_referencia: z.string().date().optional(),
});

// O5-05b — Painel de acompanhamento dos apontamentos do controle interno. Consolida a
// contagem por situação e destaca os VENCIDOS: apontamentos ainda em curso (aberto ou
// em_implementacao) cujo prazo já passou da data de referência. Um apontamento encerrado
// (implementado/nao_implementado) nunca é vencido. Reusa analytics.read.
export const getInternalControlSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SummaryInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "analytics.read");
    const ref = data.data_referencia ?? new Date().toISOString().slice(0, 10);
    const row = (
      await query<{
        aberto: string;
        em_implementacao: string;
        implementado: string;
        nao_implementado: string;
        vencidos: string;
        total: string;
      }>(
        `select
           count(*) filter (where status='aberto')::text as aberto,
           count(*) filter (where status='em_implementacao')::text as em_implementacao,
           count(*) filter (where status='implementado')::text as implementado,
           count(*) filter (where status='nao_implementado')::text as nao_implementado,
           count(*) filter (
             where status in ('aberto','em_implementacao') and prazo < $2::date
           )::text as vencidos,
           count(*)::text as total
         from public.internal_control_findings where tenant_id = $1`,
        [data.tenant_id, ref],
      )
    )[0];
    return {
      data_referencia: ref,
      porStatus: {
        aberto: Number(row.aberto),
        em_implementacao: Number(row.em_implementacao),
        implementado: Number(row.implementado),
        nao_implementado: Number(row.nao_implementado),
      },
      vencidos: Number(row.vencidos),
      total: Number(row.total),
    };
  });

const OpenInput = z.object({
  tenant_id: z.string().uuid(),
  area: z.string().trim().min(2).max(120),
  descricao: z.string().trim().min(3).max(2000),
  recomendacao: z.string().trim().min(3).max(2000),
  responsavel: z.string().trim().min(2).max(200),
  aberto_em: z.string().date(),
  prazo: z.string().date(),
});

// Registra um apontamento: número sequencial por ano (contador travado FOR UPDATE).
export const openInternalControlFinding = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => OpenInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "analytics.manage");
    if (data.prazo < data.aberto_em)
      throw new Error("O prazo não pode ser anterior à abertura");
    const ano = Number(data.aberto_em.slice(0, 4));
    return withTransaction(async (client) => {
      await client.query(
        `insert into public.internal_control_counters (tenant_id, ano)
         values ($1, $2) on conflict do nothing`,
        [data.tenant_id, ano],
      );
      const counter = (
        await client.query<{ last_numero: string }>(
          `select last_numero::text from public.internal_control_counters
           where tenant_id=$1 and ano=$2 for update`,
          [data.tenant_id, ano],
        )
      ).rows[0];
      const numero = Number(counter.last_numero) + 1;
      await client.query(
        `update public.internal_control_counters set last_numero=$3
         where tenant_id=$1 and ano=$2`,
        [data.tenant_id, ano, numero],
      );
      const id = randomUUID();
      await client.query(
        `insert into public.internal_control_findings
           (id, tenant_id, ano, numero, area, descricao, recomendacao,
            responsavel, prazo, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          data.tenant_id,
          ano,
          numero,
          data.area,
          data.descricao,
          data.recomendacao,
          data.responsavel,
          data.prazo,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "open",
        resource: "internal_control_findings",
        recordId: id,
        after: { ano, numero, area: data.area },
      });
      return { id, numero, ano };
    });
  });

const TransitionInput = z.object({
  tenant_id: z.string().uuid(),
  finding_id: z.string().uuid(),
  novo_status: z.enum(["em_implementacao", "implementado", "nao_implementado"]),
  providencia: z.string().trim().min(3).max(2000),
  data_referencia: z.string().date(),
});

// Acompanha o apontamento: em_implementacao é intermediário; implementado/
// nao_implementado encerram (gravam a conclusão). Um apontamento encerrado não
// transita de novo.
export const updateInternalControlFinding = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TransitionInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "analytics.manage");
    const encerrado = data.novo_status !== "em_implementacao";
    return withTransaction(async (client) => {
      const finding = (
        await client.query<{ status: string }>(
          `select status from public.internal_control_findings
           where id=$1 and tenant_id=$2 for update`,
          [data.finding_id, data.tenant_id],
        )
      ).rows[0];
      if (!finding) throw new Error("Apontamento não encontrado");
      if (
        finding.status === "implementado" ||
        finding.status === "nao_implementado"
      )
        throw new Error("Apontamento já encerrado não transita de novo");
      await client.query(
        `update public.internal_control_findings
         set status=$3, providencia=$4,
             concluido_em=case when $5 then $6::date else concluido_em end,
             updated_at=now()
         where id=$1 and tenant_id=$2`,
        [
          data.finding_id,
          data.tenant_id,
          data.novo_status,
          data.providencia,
          encerrado,
          data.data_referencia,
        ],
      );
      // Razao append-only do acompanhamento: guarda cada atualizacao (a coluna
      // providencia do apontamento so mantem a ultima; o historico fica aqui).
      await client.query(
        `insert into public.internal_control_followups
           (tenant_id, finding_id, status, providencia, data_referencia, created_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          data.tenant_id,
          data.finding_id,
          data.novo_status,
          data.providencia,
          data.data_referencia,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.novo_status,
        resource: "internal_control_findings",
        recordId: data.finding_id,
        after: { novo_status: data.novo_status },
      });
      return { id: data.finding_id, status: data.novo_status };
    });
  });

const FollowupsInput = z.object({
  tenant_id: z.string().uuid(),
  finding_id: z.string().uuid(),
});

// O5-05c — Historico de acompanhamento de um apontamento. Lista os
// acompanhamentos (status daquele momento + providencia) em ordem cronologica —
// a trilha de como o apontamento evoluiu, isolada por `finding_id`. Read-only,
// reusa analytics.read.
export const getInternalControlFollowups = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => FollowupsInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "analytics.read");
    const followups = await query<{
      id: string;
      status: string;
      providencia: string;
      data_referencia: string;
    }>(
      `select id, status, providencia, data_referencia::text
       from public.internal_control_followups
       where tenant_id = $1 and finding_id = $2
       order by created_at, id`,
      [data.tenant_id, data.finding_id],
    );
    return { followups };
  });
