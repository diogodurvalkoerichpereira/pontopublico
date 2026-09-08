// Escrita da trilha de auditoria (public.audit_events). Ponto único: todo ato
// que grava auditoria passa por aqui, para que colunas, metadados de requisição
// (request_id, ip) e serialização jsonb sejam idênticos em toda a aplicação. Ver
// ADR 0015 e tests/audit-helper.test.mjs (proíbe insert cru fora deste arquivo).
//
// SOMENTE servidor. Antes disto, ~10 módulos reimplementavam o mesmo insert e os
// módulos de saída de dados (remessa, exportação, eSocial, migração) não gravavam
// trilha nenhuma.
import { getRequest } from "@tanstack/react-start/server";
import { randomUUID } from "node:crypto";
import { query as poolQuery } from "./db.server";

export interface AuditEvent {
  tenantId: string | null;
  actorId: string | null;
  action: string;
  resource: string;
  recordId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Executor mínimo: o pool (`query`) ou um `PoolClient` de transação. */
interface AuditExecutor {
  query: (text: string, params?: unknown[]) => unknown;
}

/** request_id e ip da requisição atual, quando houver. */
export function auditRequestMetadata(): {
  requestId: string;
  ip: string | null;
} {
  const request = getRequest();
  return {
    requestId: request?.headers?.get("x-request-id") ?? randomUUID(),
    ip: request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
  };
}

/**
 * Grava um evento de auditoria usando o executor dado — passe o `PoolClient`
 * quando estiver dentro de uma transação, para que a trilha seja atômica com o
 * ato auditado. Fora de transação, use `recordAuditQ`.
 */
export async function recordAudit(
  client: AuditExecutor,
  event: AuditEvent,
): Promise<void> {
  const meta = auditRequestMetadata();
  await client.query(
    `insert into public.audit_events
       (tenant_id, actor_id, action, resource, record_id, before_data, after_data, request_id, ip)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::inet)`,
    [
      event.tenantId,
      event.actorId,
      event.action,
      event.resource,
      event.recordId ?? null,
      event.before == null ? null : JSON.stringify(event.before),
      event.after == null ? null : JSON.stringify(event.after),
      meta.requestId,
      meta.ip,
    ],
  );
}

/** Grava a trilha fora de transação, direto no pool. */
export function recordAuditQ(event: AuditEvent): Promise<void> {
  return recordAudit({ query: poolQuery }, event);
}
