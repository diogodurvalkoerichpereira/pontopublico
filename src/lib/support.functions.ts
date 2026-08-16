import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
export const findContextualHelp = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        route: z.string().max(300),
        search: z.string().max(100).default(""),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "support.use");
    const term = `%${data.search.replace(/[%_]/g, "")}%`;
    return query<any>(
      `select id,title,content,route_pattern,tags from public.support_articles where published and (tenant_id is null or tenant_id=$1) and ($2='' or title ilike $3 or content ilike $3 or $2=any(tags) or $4 like coalesce(route_pattern,'')||'%') order by case when $4 like coalesce(route_pattern,'')||'%' then 0 else 1 end,updated_at desc limit 8`,
      [data.tenant_id, data.search, term, data.route],
    );
  });
export const openSupportConversation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        subject: z.string().min(3).max(160),
        message: z.string().min(3).max(4000),
        route_context: z.string().max(300),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "support.use");
    const c = (
      await query<{ id: string }>(
        `insert into public.support_conversations(tenant_id,user_id,subject,route_context) values($1,$2,$3,$4) returning id`,
        [data.tenant_id, context.userId, data.subject, data.route_context],
      )
    )[0];
    await query(
      `insert into public.support_messages(conversation_id,sender_id,body) values($1,$2,$3)`,
      [c.id, context.userId, data.message],
    );
    return { id: c.id, status: "open" as const };
  });
