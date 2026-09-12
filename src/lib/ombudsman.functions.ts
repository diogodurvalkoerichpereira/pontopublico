// O5-03 — Ouvidoria (Onda 5, Lei 13.460/2017). Manifestações do cidadão
// (denúncia, reclamação, sugestão, elogio, informação, solicitação) com
// numeração sequencial por ente/ano (contador travado FOR UPDATE), prazo de
// resposta e o ciclo recebida→em_analise→respondida. Reusa as permissões de
// protocolo (protocol.*).
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

const SummaryInput = z.object({
  tenant_id: z.string().uuid(),
  data_referencia: z.string().date().optional(),
});

// O5-03b — Painel da ouvidoria (Lei 13.460). Consolida as manifestações por **tipo**
// (denúncia, reclamação, sugestão, elogio, informação, solicitação), a contagem em aberto
// (recebida/em_analise), as **vencidas** (em aberto com prazo passado) e a tempestividade
// das respondidas (no prazo quando respondida até o prazo; fora quando depois). Reusa
// protocol.read.
export const getOmbudsmanSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SummaryInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");
    const ref = data.data_referencia ?? new Date().toISOString().slice(0, 10);
    const row = (
      await query<{
        denuncia: string;
        reclamacao: string;
        sugestao: string;
        elogio: string;
        informacao: string;
        solicitacao: string;
        em_aberto: string;
        vencidas: string;
        respondidas_no_prazo: string;
        respondidas_fora_prazo: string;
        total: string;
      }>(
        `select
           count(*) filter (where tipo='denuncia')::text as denuncia,
           count(*) filter (where tipo='reclamacao')::text as reclamacao,
           count(*) filter (where tipo='sugestao')::text as sugestao,
           count(*) filter (where tipo='elogio')::text as elogio,
           count(*) filter (where tipo='informacao')::text as informacao,
           count(*) filter (where tipo='solicitacao')::text as solicitacao,
           count(*) filter (where status in ('recebida','em_analise'))::text as em_aberto,
           count(*) filter (
             where status in ('recebida','em_analise') and prazo_resposta < $2::date
           )::text as vencidas,
           count(*) filter (
             where respondida_em is not null and respondida_em <= prazo_resposta
           )::text as respondidas_no_prazo,
           count(*) filter (
             where respondida_em is not null and respondida_em > prazo_resposta
           )::text as respondidas_fora_prazo,
           count(*)::text as total
         from public.ombudsman_manifestations where tenant_id = $1`,
        [data.tenant_id, ref],
      )
    )[0];
    return {
      data_referencia: ref,
      porTipo: {
        denuncia: Number(row.denuncia),
        reclamacao: Number(row.reclamacao),
        sugestao: Number(row.sugestao),
        elogio: Number(row.elogio),
        informacao: Number(row.informacao),
        solicitacao: Number(row.solicitacao),
      },
      emAberto: Number(row.em_aberto),
      vencidas: Number(row.vencidas),
      respondidasNoPrazo: Number(row.respondidas_no_prazo),
      respondidasForaPrazo: Number(row.respondidas_fora_prazo),
      total: Number(row.total),
    };
  });

export const getManifestations = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");
    const manifestations = await query<{
      id: string;
      ano: number;
      numero: string;
      tipo: string;
      canal: string;
      anonima: boolean;
      status: string;
      prazo_resposta: string;
      respondida_em: string | null;
      created_at: string;
    }>(
      `select id, ano, numero::text, tipo, canal, anonima, status,
         prazo_resposta::text, respondida_em::text, created_at::text
       from public.ombudsman_manifestations
       where tenant_id = $1 and ($2::int is null or ano = $2)
       order by ano desc, numero desc`,
      [data.tenant_id, data.ano ?? null],
    );
    return {
      manifestations,
      canManage: access.permissions.includes("protocol.manage"),
    };
  });

const OpenInput = z.object({
  tenant_id: z.string().uuid(),
  tipo: z.enum([
    "denuncia",
    "reclamacao",
    "sugestao",
    "elogio",
    "informacao",
    "solicitacao",
  ]),
  canal: z.enum(["web", "presencial", "telefone", "email", "carta"]),
  anonima: z.boolean().default(false),
  descricao: z.string().trim().min(3).max(5000),
  aberta_em: z.string().date(),
  // Prazo legal padrão da Lei 13.460 é 30 dias; deixamos parametrizável.
  prazo_dias: z.number().int().min(1).max(365).default(30),
});

// Abre uma manifestação: número sequencial por ano (contador travado FOR UPDATE)
// e prazo de resposta calculado a partir da abertura.
export const openManifestation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => OpenInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    const ano = Number(data.aberta_em.slice(0, 4));
    const prazo = new Date(`${data.aberta_em}T00:00:00Z`);
    prazo.setUTCDate(prazo.getUTCDate() + data.prazo_dias);
    const prazoResposta = prazo.toISOString().slice(0, 10);
    return withTransaction(async (client) => {
      await client.query(
        `insert into public.ombudsman_counters (tenant_id, ano)
         values ($1, $2) on conflict do nothing`,
        [data.tenant_id, ano],
      );
      const counter = (
        await client.query<{ last_numero: string }>(
          `select last_numero::text from public.ombudsman_counters
           where tenant_id=$1 and ano=$2 for update`,
          [data.tenant_id, ano],
        )
      ).rows[0];
      const numero = Number(counter.last_numero) + 1;
      await client.query(
        `update public.ombudsman_counters set last_numero=$3
         where tenant_id=$1 and ano=$2`,
        [data.tenant_id, ano, numero],
      );
      const id = randomUUID();
      await client.query(
        `insert into public.ombudsman_manifestations
           (id, tenant_id, ano, numero, tipo, canal, anonima, descricao,
            prazo_resposta, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          data.tenant_id,
          ano,
          numero,
          data.tipo,
          data.canal,
          data.anonima,
          data.descricao,
          prazoResposta,
          // Manifestação anônima não vincula o autor.
          data.anonima ? null : context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "open",
        resource: "ombudsman_manifestations",
        recordId: id,
        after: { ano, numero, tipo: data.tipo, canal: data.canal },
      });
      return { id, numero, ano, prazo_resposta: prazoResposta };
    });
  });

const RespondInput = z.object({
  tenant_id: z.string().uuid(),
  manifestation_id: z.string().uuid(),
  resposta: z.string().trim().min(3).max(5000),
  respondida_em: z.string().date(),
});

// Responde a manifestação: transiciona recebida/em_analise→respondida e grava a
// resposta com a data. Uma manifestação já respondida ou arquivada não responde
// de novo.
export const respondManifestation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => RespondInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    return withTransaction(async (client) => {
      const manifestation = (
        await client.query<{ status: string }>(
          `select status from public.ombudsman_manifestations
           where id=$1 and tenant_id=$2 for update`,
          [data.manifestation_id, data.tenant_id],
        )
      ).rows[0];
      if (!manifestation) throw new Error("Manifestação não encontrada");
      if (
        manifestation.status !== "recebida" &&
        manifestation.status !== "em_analise"
      )
        throw new Error("Só uma manifestação em aberto pode ser respondida");
      await client.query(
        `update public.ombudsman_manifestations
         set status='respondida', resposta=$3, respondida_em=$4::date,
             updated_at=now()
         where id=$1 and tenant_id=$2`,
        [
          data.manifestation_id,
          data.tenant_id,
          data.resposta,
          data.respondida_em,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "respond",
        resource: "ombudsman_manifestations",
        recordId: data.manifestation_id,
        after: { respondida_em: data.respondida_em },
      });
      return { id: data.manifestation_id, status: "respondida" };
    });
  });

const ArchiveInput = z.object({
  tenant_id: z.string().uuid(),
  manifestation_id: z.string().uuid(),
});

// O5-03b — Arquiva a manifestação (Lei 13.460). Só uma manifestação **respondida** é
// arquivada (encerra o atendimento); recebida/em análise precisa ser respondida antes, e
// arquivada é terminal. Fecha o ciclo da ouvidoria. Reusa protocol.manage.
export const archiveManifestation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ArchiveInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    return withTransaction(async (client) => {
      const manifestation = (
        await client.query<{ status: string }>(
          `select status from public.ombudsman_manifestations
           where id=$1 and tenant_id=$2 for update`,
          [data.manifestation_id, data.tenant_id],
        )
      ).rows[0];
      if (!manifestation) throw new Error("Manifestação não encontrada");
      if (manifestation.status !== "respondida")
        throw new Error("Só uma manifestação respondida pode ser arquivada");
      await client.query(
        `update public.ombudsman_manifestations
         set status='arquivada', updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.manifestation_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "archive",
        resource: "ombudsman_manifestations",
        recordId: data.manifestation_id,
        after: { status: "arquivada" },
      });
      return { id: data.manifestation_id, status: "arquivada" };
    });
  });
