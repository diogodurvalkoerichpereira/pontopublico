// O5-09 — Carta de Serviços ao Cidadão (Onda 5, Lei 13.460 art. 7º). Catálogo dos
// serviços do ente (descrição, requisitos, prazo, canais, taxa). Só um serviço completo
// — com descrição, prazo (> 0) e canais — pode ser publicado ao cidadão. Reusa protocol.*.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  publicado: z.boolean().optional(),
});

export const getCitizenServices = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(GetInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");
    const services = await query<{
      id: string;
      nome: string;
      descricao: string;
      requisitos: string | null;
      prazo_dias: number;
      canais: string | null;
      taxa: string;
      publicado: boolean;
    }>(
      `select id, nome, descricao, requisitos, prazo_dias, canais, taxa::text, publicado
       from public.citizen_services
       where tenant_id = $1 and ($2::boolean is null or publicado = $2)
       order by nome`,
      [data.tenant_id, data.publicado ?? null],
    );
    return {
      services,
      canManage: access.permissions.includes("protocol.manage"),
    };
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  nome: z.string().trim().min(2).max(120),
  descricao: z.string().trim().min(3).max(4000),
  requisitos: z.string().trim().max(4000).nullable().optional(),
  prazo_dias: z.number().int().min(0).max(3650),
  canais: z.string().trim().max(500).nullable().optional(),
  taxa: z.number().min(0).max(1_000_000_000).default(0),
});

export const saveCitizenService = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.citizen_services
       where tenant_id=$1 and lower(nome)=lower($2)
         and ($3::uuid is null or id<>$3)`,
      [data.tenant_id, data.nome, data.id ?? null],
    );
    if (duplicate) throw new Error("Já existe serviço com este nome");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.citizen_services
           set nome=$3, descricao=$4, requisitos=$5, prazo_dias=$6, canais=$7,
               taxa=$8, updated_at=now()
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.nome,
            data.descricao,
            data.requisitos ?? null,
            data.prazo_dias,
            data.canais ?? null,
            data.taxa,
          ],
        );
      } else {
        await client.query(
          `insert into public.citizen_services
             (id, tenant_id, nome, descricao, requisitos, prazo_dias, canais, taxa, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            data.tenant_id,
            data.nome,
            data.descricao,
            data.requisitos ?? null,
            data.prazo_dias,
            data.canais ?? null,
            data.taxa,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "citizen_services",
        recordId: id,
        after: { nome: data.nome },
      });
    });
    return { id };
  });

const PublishInput = z.object({
  tenant_id: z.string().uuid(),
  service_id: z.string().uuid(),
  publicar: z.boolean(),
});

// Publica ou despublica o serviço. Publicar exige completude (descrição, prazo > 0 e
// canais); despublicar é sempre permitido.
export const publishCitizenService = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(PublishInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    return withTransaction(async (client) => {
      const service = (
        await client.query<{
          descricao: string;
          prazo_dias: number;
          canais: string | null;
        }>(
          `select descricao, prazo_dias, canais
           from public.citizen_services where id=$1 and tenant_id=$2 for update`,
          [data.service_id, data.tenant_id],
        )
      ).rows[0];
      if (!service) throw new Error("Serviço não encontrado");
      if (data.publicar) {
        const completo =
          service.descricao.trim().length > 0 &&
          service.prazo_dias > 0 &&
          (service.canais ?? "").trim().length > 0;
        if (!completo)
          throw new Error(
            "Serviço incompleto não pode ser publicado (exige descrição, prazo e canais)",
          );
      }
      await client.query(
        `update public.citizen_services set publicado=$3, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.service_id, data.tenant_id, data.publicar],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.publicar ? "publish" : "unpublish",
        resource: "citizen_services",
        recordId: data.service_id,
        after: { publicado: data.publicar },
      });
      return { id: data.service_id, publicado: data.publicar };
    });
  });
