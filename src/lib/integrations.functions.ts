// O5-10 — Integrações externas (chatbot menuia, bealys) e canais de alerta (WhatsApp,
// e-mail), configuráveis por ente com liga/desliga. A CREDENCIAL de cada integração fica no
// servidor e nunca é devolvida ao cliente — a leitura só informa `has_credential`. O envio
// efetivo às plataformas externas exige credencial/endpoint reais (homologação externa);
// aqui está a configuração e o estado de ativação. Reusa org.read/org.manage.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const PROVIDERS = ["menuia", "bealys"] as const;
const CANAIS = ["whatsapp", "email"] as const;

const TenantInput = z.object({ tenant_id: z.string().uuid() });

// Lista as integrações do ente (todos os provedores conhecidos, mesmo sem configuração),
// sem jamais expor a credencial — só se existe uma (`has_credential`).
export const getIntegrationSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "org.read");
    const rows = await query<{
      provider: string;
      enabled: boolean;
      base_url: string | null;
      has_credential: boolean;
    }>(
      `select provider, enabled, base_url,
         (credential is not null and btrim(credential) <> '') as has_credential
       from public.integration_settings
       where tenant_id = $1`,
      [data.tenant_id],
    );
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    return {
      providers: PROVIDERS.map((provider) => {
        const r = byProvider.get(provider);
        return {
          provider,
          enabled: r?.enabled ?? false,
          base_url: r?.base_url ?? null,
          has_credential: r?.has_credential ?? false,
        };
      }),
      canManage: access.permissions.includes("org.manage"),
    };
  });

const SaveIntegrationInput = z.object({
  tenant_id: z.string().uuid(),
  provider: z.enum(PROVIDERS),
  enabled: z.boolean(),
  base_url: z.string().trim().url().max(300).nullable().optional(),
  // Credencial: omitida = mantém a atual; string vazia = remove; string = grava.
  credential: z.string().trim().max(500).nullable().optional(),
});

// Salva a configuração de uma integração. Para **ligar** (enabled=true) exige uma base_url
// (nova ou já salva) — não se ativa uma integração sem endpoint. A credencial nunca volta na
// resposta.
export const saveIntegrationSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveIntegrationInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "org.manage");
    return withTransaction(async (client) => {
      const current = (
        await client.query<{ base_url: string | null }>(
          `select base_url from public.integration_settings
           where tenant_id=$1 and provider=$2 for update`,
          [data.tenant_id, data.provider],
        )
      ).rows[0];
      const novaBaseUrl =
        data.base_url !== undefined
          ? data.base_url
          : (current?.base_url ?? null);
      if (data.enabled && !novaBaseUrl)
        throw new Error("Defina a URL da integração antes de ativá-la");
      // credential: undefined mantém; null/'' limpa; texto grava.
      const credentialClause =
        data.credential === undefined ? "" : ", credential = $6";
      const params: unknown[] = [
        data.tenant_id,
        data.provider,
        data.enabled,
        novaBaseUrl,
        context.userId,
      ];
      if (data.credential !== undefined)
        params.push(data.credential ? data.credential : null);
      await client.query(
        `insert into public.integration_settings
           (tenant_id, provider, enabled, base_url, created_by, credential)
         values ($1,$2,$3,$4,$5,${data.credential !== undefined ? "$6" : "null"})
         on conflict (tenant_id, provider) do update
           set enabled = excluded.enabled,
               base_url = excluded.base_url,
               updated_at = now()${credentialClause}`,
        params,
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "save_integration",
        resource: "integration_settings",
        recordId: data.tenant_id,
        after: {
          provider: data.provider,
          enabled: data.enabled,
          base_url: novaBaseUrl,
          credential_changed: data.credential !== undefined,
        },
      });
      return { provider: data.provider, enabled: data.enabled };
    });
  });

export const getAlertSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "org.read");
    const rows = await query<{
      canal: string;
      enabled: boolean;
      destinatarios: string[];
      eventos: string[];
    }>(
      `select canal, enabled, destinatarios, eventos
       from public.alert_settings where tenant_id = $1`,
      [data.tenant_id],
    );
    const byCanal = new Map(rows.map((r) => [r.canal, r]));
    return {
      canais: CANAIS.map((canal) => {
        const r = byCanal.get(canal);
        return {
          canal,
          enabled: r?.enabled ?? false,
          destinatarios: r?.destinatarios ?? [],
          eventos: r?.eventos ?? [],
        };
      }),
      canManage: access.permissions.includes("org.manage"),
    };
  });

const SaveAlertInput = z.object({
  tenant_id: z.string().uuid(),
  canal: z.enum(CANAIS),
  enabled: z.boolean(),
  destinatarios: z
    .array(z.string().trim().min(1).max(120))
    .max(100)
    .default([]),
  eventos: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
});

// Salva um canal de alerta. Para **ligar** exige ao menos um destinatário (número de
// WhatsApp ou e-mail) — não se ativa um canal sem para quem enviar.
export const saveAlertSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveAlertInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "org.manage");
    const destinatarios = data.destinatarios.filter((d) => d.trim() !== "");
    if (data.enabled && destinatarios.length === 0)
      throw new Error("Informe ao menos um destinatário para ativar o canal");
    return withTransaction(async (client) => {
      await client.query(
        `insert into public.alert_settings
           (tenant_id, canal, enabled, destinatarios, eventos, created_by)
         values ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
         on conflict (tenant_id, canal) do update
           set enabled = excluded.enabled,
               destinatarios = excluded.destinatarios,
               eventos = excluded.eventos,
               updated_at = now()`,
        [
          data.tenant_id,
          data.canal,
          data.enabled,
          JSON.stringify(destinatarios),
          JSON.stringify(data.eventos),
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "save_alert_channel",
        resource: "alert_settings",
        recordId: data.tenant_id,
        after: {
          canal: data.canal,
          enabled: data.enabled,
          destinatarios: destinatarios.length,
          eventos: data.eventos,
        },
      });
      return { canal: data.canal, enabled: data.enabled };
    });
  });
