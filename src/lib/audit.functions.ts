import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const AuditInput = z.object({
  tenant_id: z.string().uuid(),
  search: z.string().trim().max(120).optional().default(""),
  resource: z.string().trim().max(80).optional().default(""),
  action: z.string().trim().max(40).optional().default(""),
  page: z.number().int().min(1).max(10000).optional().default(1),
  page_size: z.number().int().min(10).max(100).optional().default(30),
});

export interface AuditEventView {
  id: number;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  resource: string;
  record_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  request_id: string | null;
  ip: string | null;
  created_at: string;
}

export const getAuditEvents = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => AuditInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "audit.read");
    const params: unknown[] = [data.tenant_id];
    const filters: string[] = ["ae.tenant_id = $1"];
    if (data.resource) {
      params.push(data.resource);
      filters.push(`ae.resource = $${params.length}`);
    }
    if (data.action) {
      params.push(data.action);
      filters.push(`ae.action = $${params.length}`);
    }
    if (data.search) {
      params.push(`%${data.search}%`);
      filters.push(`(
        ae.record_id ilike $${params.length}
        or ae.request_id ilike $${params.length}
        or p.full_name ilike $${params.length}
        or p.email ilike $${params.length}
      )`);
    }
    const where = filters.join(" and ");
    const count = await query<{ total: number }>(
      `select count(*)::int as total
       from public.audit_events ae
       left join public.profiles p on p.id = ae.actor_id
       where ${where}`,
      params,
    );
    params.push(data.page_size, (data.page - 1) * data.page_size);
    const events = await query<AuditEventView>(
      `select ae.id, ae.actor_id, p.full_name as actor_name, p.email as actor_email,
         ae.action, ae.resource, ae.record_id, ae.before_data, ae.after_data,
         ae.request_id, ae.ip::text, ae.created_at::text
       from public.audit_events ae
       left join public.profiles p on p.id = ae.actor_id
       where ${where}
       order by ae.created_at desc, ae.id desc
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return {
      events,
      total: count[0]?.total ?? 0,
      page: data.page,
      pageSize: data.page_size,
    };
  });
