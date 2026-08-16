import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

export const savePushSubscription = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        endpoint: z.string().url().max(2048),
        p256dh: z.string().min(20).max(512),
        auth: z.string().min(8).max(256),
        user_agent: z.string().max(512).optional(),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    await loadTenantAccess(context.userId, data.tenant_id);
    await query(
      `insert into public.push_subscriptions(tenant_id,user_id,endpoint,p256dh,auth_secret,user_agent)
      values($1,$2,$3,$4,$5,$6) on conflict(user_id,endpoint) do update set p256dh=excluded.p256dh,auth_secret=excluded.auth_secret,user_agent=excluded.user_agent,updated_at=now()`,
      [
        data.tenant_id,
        context.userId,
        data.endpoint,
        data.p256dh,
        data.auth,
        data.user_agent ?? null,
      ],
    );
    return { saved: true };
  });

export const queuePushNotification = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        title: z.string().min(1).max(120),
        body: z.string().min(1).max(500),
        target_url: z.string().max(500).default("/"),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "mobile.push.manage");
    const rows = await query<{ id: string }>(
      `insert into public.push_notifications(tenant_id,title,body,target_url,created_by) values($1,$2,$3,$4,$5) returning id`,
      [data.tenant_id, data.title, data.body, data.target_url, context.userId],
    );
    return { id: rows[0].id, status: "queued" as const };
  });
