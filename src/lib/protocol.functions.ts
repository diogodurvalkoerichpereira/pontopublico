// O5-01 — Protocolo / processo eletrônico (Onda 5). Abertura com numeração
// sequencial por ente/ano (contador travado) e tramitação entre unidades com
// histórico. A tramitação atualiza a unidade atual do processo.
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

export const getProtocolProcesses = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");
    const processes = await query<{
      id: string;
      ano: number;
      numero: string;
      assunto: string;
      interessado: string;
      unidade_atual_id: string | null;
      status: string;
      aberto_em: string;
    }>(
      `select id, ano, numero::text, assunto, interessado, unidade_atual_id,
         status, aberto_em::text
       from public.protocol_processes
       where tenant_id = $1 and ($2::int is null or ano = $2)
       order by ano desc, numero desc`,
      [data.tenant_id, data.ano ?? null],
    );
    return {
      processes,
      canManage: access.permissions.includes("protocol.manage"),
    };
  });

const SummaryInput = z.object({ tenant_id: z.string().uuid() });

// O5-01d — Resumo do protocolo: contagem de processos por situação (em tramitação,
// concluído, arquivado) e total. Reusa protocol.read.
export const getProtocolSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SummaryInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");
    const row = (
      await query<{
        em_tramitacao: string;
        concluido: string;
        arquivado: string;
        total: string;
      }>(
        `select
           count(*) filter (where status='em_tramitacao')::text as em_tramitacao,
           count(*) filter (where status='concluido')::text as concluido,
           count(*) filter (where status='arquivado')::text as arquivado,
           count(*)::text as total
         from public.protocol_processes where tenant_id = $1`,
        [data.tenant_id],
      )
    )[0];
    return {
      emTramitacao: Number(row.em_tramitacao),
      concluidos: Number(row.concluido),
      arquivados: Number(row.arquivado),
      total: Number(row.total),
    };
  });

const DetailInput = z.object({
  tenant_id: z.string().uuid(),
  process_id: z.string().uuid(),
});

// O5-01b — Histórico de tramitação do processo. Devolve o cabeçalho do processo e o
// trilho de movimentações em ordem cronológica (do despacho mais antigo ao mais recente),
// com o nome das unidades de origem e destino. É a linha do tempo do processo para o
// detalhe e a auditoria. Reusa protocol.read.
export const getProtocolMovements = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => DetailInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");
    const process = await query<{
      id: string;
      ano: number;
      numero: string;
      assunto: string;
      interessado: string;
      status: string;
      aberto_em: string;
      unidade_atual: string | null;
    }>(
      `select p.id, p.ano, p.numero::text, p.assunto, p.interessado, p.status,
         p.aberto_em::text, u.nome as unidade_atual
       from public.protocol_processes p
       left join public.unidades u on u.id = p.unidade_atual_id
       where p.id = $1 and p.tenant_id = $2`,
      [data.process_id, data.tenant_id],
    );
    if (process.length === 0) throw new Error("Processo não encontrado");
    const movements = await query<{
      id: string;
      unidade_origem: string | null;
      unidade_destino: string | null;
      despacho: string;
      data_movimento: string;
    }>(
      `select m.id, o.nome as unidade_origem, d.nome as unidade_destino,
         m.despacho, m.data_movimento::text
       from public.protocol_movements m
       left join public.unidades o on o.id = m.unidade_origem_id
       left join public.unidades d on d.id = m.unidade_destino_id
       where m.process_id = $1 and m.tenant_id = $2
       order by m.data_movimento, m.id`,
      [data.process_id, data.tenant_id],
    );
    return { process: process[0], movements };
  });

const OpenInput = z.object({
  tenant_id: z.string().uuid(),
  assunto: z.string().trim().min(3).max(300),
  interessado: z.string().trim().min(2).max(200),
  unidade_id: z.string().uuid().nullable().optional(),
  aberto_em: z.string().date(),
});

// Abre um processo: número sequencial por ano (contador travado FOR UPDATE).
export const openProtocolProcess = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => OpenInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    const ano = Number(data.aberto_em.slice(0, 4));
    return withTransaction(async (client) => {
      await client.query(
        `insert into public.protocol_counters (tenant_id, ano)
         values ($1, $2) on conflict do nothing`,
        [data.tenant_id, ano],
      );
      const counter = (
        await client.query<{ last_numero: string }>(
          `select last_numero::text from public.protocol_counters
           where tenant_id=$1 and ano=$2 for update`,
          [data.tenant_id, ano],
        )
      ).rows[0];
      const numero = Number(counter.last_numero) + 1;
      await client.query(
        `update public.protocol_counters set last_numero=$3
         where tenant_id=$1 and ano=$2`,
        [data.tenant_id, ano, numero],
      );
      const id = randomUUID();
      await client.query(
        `insert into public.protocol_processes
           (id, tenant_id, ano, numero, assunto, interessado, unidade_atual_id,
            aberto_em, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          ano,
          numero,
          data.assunto,
          data.interessado,
          data.unidade_id ?? null,
          data.aberto_em,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "open",
        resource: "protocol_processes",
        recordId: id,
        after: { ano, numero, assunto: data.assunto },
      });
      return { id, numero, ano };
    });
  });

const MoveInput = z.object({
  tenant_id: z.string().uuid(),
  process_id: z.string().uuid(),
  unidade_destino_id: z.string().uuid().nullable().optional(),
  despacho: z.string().trim().min(3).max(1000),
  concluir: z.boolean().default(false),
});

// Tramita o processo: registra o despacho, move para a unidade destino e atualiza
// a unidade atual; opcionalmente conclui.
export const recordProtocolMovement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => MoveInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    return withTransaction(async (client) => {
      const process = (
        await client.query<{
          unidade_atual_id: string | null;
          status: string;
        }>(
          `select unidade_atual_id, status from public.protocol_processes
           where id=$1 and tenant_id=$2 for update`,
          [data.process_id, data.tenant_id],
        )
      ).rows[0];
      if (!process) throw new Error("Processo não encontrado");
      if (process.status !== "em_tramitacao")
        throw new Error("Processo não está em tramitação");
      const id = randomUUID();
      await client.query(
        `insert into public.protocol_movements
           (id, tenant_id, process_id, unidade_origem_id, unidade_destino_id,
            despacho, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          data.tenant_id,
          data.process_id,
          process.unidade_atual_id,
          data.unidade_destino_id ?? null,
          data.despacho,
          context.userId,
        ],
      );
      await client.query(
        `update public.protocol_processes
         set unidade_atual_id=$3, status=case when $4 then 'concluido' else status end,
             updated_at=now()
         where id=$1 and tenant_id=$2`,
        [
          data.process_id,
          data.tenant_id,
          data.unidade_destino_id ?? process.unidade_atual_id,
          data.concluir,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "move",
        resource: "protocol_processes",
        recordId: data.process_id,
        after: {
          unidade_destino_id: data.unidade_destino_id ?? null,
          concluir: data.concluir,
        },
      });
      return { id, concluido: data.concluir };
    });
  });

const ArchiveInput = z.object({
  tenant_id: z.string().uuid(),
  process_id: z.string().uuid(),
  motivo: z.string().trim().min(3).max(500),
});

// O5-01c — Arquivamento do processo. Só um processo **concluído** pode ser arquivado
// (em tramitação precisa concluir antes); arquivar é terminal. Reusa protocol.manage.
export const archiveProtocolProcess = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ArchiveInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    return withTransaction(async (client) => {
      const process = (
        await client.query<{ status: string }>(
          `select status from public.protocol_processes
           where id=$1 and tenant_id=$2 for update`,
          [data.process_id, data.tenant_id],
        )
      ).rows[0];
      if (!process) throw new Error("Processo não encontrado");
      if (process.status !== "concluido")
        throw new Error("Só um processo concluído pode ser arquivado");
      await client.query(
        `update public.protocol_processes
         set status='arquivado', updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.process_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "archive",
        resource: "protocol_processes",
        recordId: data.process_id,
        after: { status: "arquivado", motivo: data.motivo },
      });
      return { id: data.process_id, status: "arquivado" };
    });
  });
