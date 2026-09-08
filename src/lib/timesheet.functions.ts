// O0-07 — Batida de ponto como registro probatório.
//
// Criação, edição e exclusão de batida pelo RH passam por aqui, fora do shim
// genérico: cada operação valida que o funcionário-alvo pertence ao ente ativo e
// grava trilha em audit_events. A exclusão é lógica (deleted_at), reversível e
// rastreável — nunca física. O self-punch do funcionário continua no shim
// (pgrest.server.ts força user_id ao próprio usuário no insert).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const TIPO = z.enum(["entrada", "saida_almoco", "volta_almoco", "saida"]);

function auditMetadata() {
  const request = getRequest();
  return {
    requestId: request?.headers?.get("x-request-id") ?? randomUUID(),
    ip: request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
  };
}

async function assertTenantMember(
  client: PoolClient,
  tenantId: string,
  userId: string,
) {
  const res = await client.query(
    `select 1 from public.tenant_memberships
     where tenant_id = $1 and user_id = $2 and status = 'ativo'`,
    [tenantId, userId],
  );
  if (!res.rows.length) {
    throw new Error("Funcionário não pertence à entidade ativa");
  }
}

async function loadEntry(client: PoolClient, id: string) {
  const res = await client.query<{
    id: string;
    user_id: string;
    tipo: string;
    entry_at: string;
    observacao: string | null;
    deleted_at: string | null;
  }>(
    `select id, user_id, tipo, entry_at, observacao, deleted_at
     from public.time_entries where id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

const RegisterInput = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  tipo: TIPO,
  entry_at: z.string().datetime({ offset: true }),
  observacao: z.string().max(500).optional().nullable(),
});

export const registerManualTimeEntry = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => RegisterInput.parse(v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "people.manage");
    const meta = auditMetadata();
    return withTransaction(async (client) => {
      await assertTenantMember(client, data.tenant_id, data.user_id);
      const id = randomUUID();
      await client.query(
        `insert into public.time_entries
           (id, user_id, tipo, entry_at, origem, observacao, created_by)
         values ($1, $2, $3, $4, 'manual', $5, $6)`,
        [
          id,
          data.user_id,
          data.tipo,
          data.entry_at,
          data.observacao ?? null,
          context.userId,
        ],
      );
      await client.query(
        `insert into public.audit_events
           (tenant_id, actor_id, action, resource, record_id, after_data, request_id, ip)
         values ($1, $2, 'register', 'time_entries', $3, $4::jsonb, $5, $6::inet)`,
        [
          data.tenant_id,
          context.userId,
          id,
          JSON.stringify({
            user_id: data.user_id,
            tipo: data.tipo,
            entry_at: data.entry_at,
            observacao: data.observacao ?? null,
          }),
          meta.requestId,
          meta.ip,
        ],
      );
      return { id };
    });
  });

const UpdateInput = z.object({
  tenant_id: z.string().uuid(),
  id: z.string().uuid(),
  tipo: TIPO,
  entry_at: z.string().datetime({ offset: true }),
  observacao: z.string().max(500).optional().nullable(),
});

export const updateManualTimeEntry = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => UpdateInput.parse(v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "people.manage");
    const meta = auditMetadata();
    return withTransaction(async (client) => {
      const before = await loadEntry(client, data.id);
      if (!before || before.deleted_at) {
        throw new Error("Batida não encontrada");
      }
      await assertTenantMember(client, data.tenant_id, before.user_id);
      await client.query(
        `update public.time_entries
         set tipo = $2, entry_at = $3, observacao = $4,
             updated_at = now(), updated_by = $5
         where id = $1`,
        [
          data.id,
          data.tipo,
          data.entry_at,
          data.observacao ?? null,
          context.userId,
        ],
      );
      await client.query(
        `insert into public.audit_events
           (tenant_id, actor_id, action, resource, record_id, before_data, after_data, request_id, ip)
         values ($1, $2, 'update', 'time_entries', $3, $4::jsonb, $5::jsonb, $6, $7::inet)`,
        [
          data.tenant_id,
          context.userId,
          data.id,
          JSON.stringify({
            tipo: before.tipo,
            entry_at: before.entry_at,
            observacao: before.observacao,
          }),
          JSON.stringify({
            tipo: data.tipo,
            entry_at: data.entry_at,
            observacao: data.observacao ?? null,
          }),
          meta.requestId,
          meta.ip,
        ],
      );
      return { id: data.id };
    });
  });

const DeleteInput = z.object({
  tenant_id: z.string().uuid(),
  id: z.string().uuid(),
  reason: z.string().trim().min(5).max(500),
});

export const softDeleteTimeEntry = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => DeleteInput.parse(v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "people.manage");
    const meta = auditMetadata();
    return withTransaction(async (client) => {
      const before = await loadEntry(client, data.id);
      if (!before || before.deleted_at) {
        throw new Error("Batida não encontrada");
      }
      await assertTenantMember(client, data.tenant_id, before.user_id);
      await client.query(
        `update public.time_entries
         set deleted_at = now(), deleted_by = $2, delete_reason = $3
         where id = $1`,
        [data.id, context.userId, data.reason],
      );
      await client.query(
        `insert into public.audit_events
           (tenant_id, actor_id, action, resource, record_id, before_data, request_id, ip)
         values ($1, $2, 'soft_delete', 'time_entries', $3, $4::jsonb, $5, $6::inet)`,
        [
          data.tenant_id,
          context.userId,
          data.id,
          JSON.stringify({
            user_id: before.user_id,
            tipo: before.tipo,
            entry_at: before.entry_at,
            reason: data.reason,
          }),
          meta.requestId,
          meta.ip,
        ],
      );
      return { id: data.id };
    });
  });
