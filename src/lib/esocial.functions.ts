import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
const I = z.object({
  tenant_id: z.string().uuid(),
  event_type: z.string().regex(/^S-\d{4}$/),
  external_id: z.string().min(3),
  payload_xml: z.string().min(20),
});
export const enqueueEsocialEvent = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => I.parse(v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "esocial.manage");
    if (
      !data.payload_xml.trim().startsWith("<") ||
      !data.payload_xml.includes(data.event_type)
    )
      throw new Error("XML não corresponde ao tipo de evento");
    const id = randomUUID(),
      hash = createHash("sha256").update(data.payload_xml).digest("hex");
    await query(
      `insert into public.esocial_events(id,tenant_id,event_type,external_id,payload_xml,payload_sha256,status,created_by)values($1,$2,$3,$4,$5,$6,'validado',$7)`,
      [
        id,
        data.tenant_id,
        data.event_type,
        data.external_id,
        data.payload_xml,
        hash,
        context.userId,
      ],
    );
    return { id, hash };
  });
export const processEsocialQueue = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z.object({ tenant_id: z.string().uuid() }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "esocial.manage");
    return withTransaction(async (c) => {
      const cert = (
        await c.query<any>(
          `select * from public.esocial_certificates where tenant_id=$1 and active and valid_from<=now() and valid_to>now() order by valid_to desc limit 1`,
          [data.tenant_id],
        )
      ).rows[0];
      if (!cert) throw new Error("Certificado A1/A3 válido não configurado");
      const events = (
        await c.query<any>(
          `select * from public.esocial_events where tenant_id=$1 and status in('validado','erro') and next_attempt_at<=now() order by created_at limit 100 for update skip locked`,
          [data.tenant_id],
        )
      ).rows;
      for (const e of events) {
        const attempt = e.attempts + 1;
        await c.query(
          `update public.esocial_events set status='assinado',attempts=$2,updated_at=now(),last_error=null where id=$1`,
          [e.id, attempt],
        );
        await c.query(
          `insert into public.esocial_event_attempts(tenant_id,event_id,attempt_number,request_sha256,response_code,response_excerpt)values($1,$2,$3,$4,'AGUARDANDO_TRANSMISSAO','Assinatura delegada ao adaptador seguro')`,
          [data.tenant_id, e.id, attempt, e.payload_sha256],
        );
      }
      return { processed: events.length, certificate: cert.serial_number };
    });
  });
