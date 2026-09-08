/**
 * Fila de eventos do eSocial.
 *
 * ATENÇÃO — a assinatura e a transmissão NÃO estão implementadas. O XML não é
 * gerado a partir dos dados da folha: ele chega pronto de fora e a validação se
 * resume a conferir que o texto começa com "<" e cita o tipo do evento.
 *
 * Até a Sprint 20, `processEsocialQueue` marcava os eventos como `assinado` sem
 * executar nenhuma operação criptográfica, registrando a tentativa com a nota
 * "Assinatura delegada ao adaptador seguro" — adaptador que não existe neste
 * repositório. Isso produzia um estado de sucesso que não correspondia ao que
 * havia acontecido, e faria uma prova de conceito exibir um evento "assinado"
 * que nunca foi assinado.
 *
 * A função agora falha de forma explícita. Voltará a operar quando existirem:
 * geração de XML a partir da folha, assinatura XMLDSig com certificado A1/A3 e
 * transmissão com tratamento de protocolo e recibo. Ver src/lib/conformance.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import { conformanceOf, NotImplementedConformanceError } from "./conformance";
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
    // Não há assinador nem transmissor. Marcar os eventos como `assinado` aqui
    // registraria um fato que não ocorreu, então a operação falha explicitamente.
    throw new NotImplementedConformanceError("esocial-transmissao");
  });

/**
 * Situação da fila do eSocial: contagem por status e o estado de conformidade
 * da integração. Substitui o uso de `processEsocialQueue` como se ela fosse
 * capaz de avançar a fila.
 */
export const getEsocialQueueStatus = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z.object({ tenant_id: z.string().uuid() }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "esocial.read");
    return {
      porStatus: await query<{ status: string; total: string }>(
        `select status,count(*)::text total from public.esocial_events where tenant_id=$1 group by status order by status`,
        [data.tenant_id],
      ),
      conformidade: conformanceOf("esocial-transmissao"),
    };
  });
