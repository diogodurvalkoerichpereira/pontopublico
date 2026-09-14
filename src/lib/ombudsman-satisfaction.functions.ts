// O5-07 — Avaliação de satisfação da ouvidoria (Onda 5, Lei 13.460 art. 23). Depois de
// respondida a manifestação, o cidadão avalia o atendimento (nota 1-5). O indicador
// consolida média, total e distribuição das notas. Reusa protocol.*. Uma avaliação por
// manifestação.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const GetInput = z.object({ tenant_id: z.string().uuid() });

export const getOmbudsmanSatisfaction = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(GetInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");
    const rows = await query<{ nota: number; qtd: string }>(
      `select nota, count(*)::text as qtd
       from public.ombudsman_satisfaction
       where tenant_id = $1
       group by nota`,
      [data.tenant_id],
    );
    const distribuicao: Record<number, number> = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };
    let total = 0;
    let somaNotas = 0;
    for (const r of rows) {
      const qtd = Number(r.qtd);
      distribuicao[r.nota] = qtd;
      total += qtd;
      somaNotas += r.nota * qtd;
    }
    // Média das notas (0 quando não há avaliação).
    const media = total > 0 ? Number((somaNotas / total).toFixed(2)) : 0;
    return { total, media, distribuicao };
  });

const RateInput = z.object({
  tenant_id: z.string().uuid(),
  manifestation_id: z.string().uuid(),
  nota: z.number().int().min(1).max(5),
  comentario: z.string().trim().max(1000).nullable().optional(),
  avaliado_em: z.string().date(),
});

// Registra a avaliação do cidadão. Só uma manifestação respondida pode ser avaliada;
// uma avaliação por manifestação (unique + guarda de estado).
export const rateManifestation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(RateInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.manage");
    return withTransaction(async (client) => {
      const manifestation = (
        await client.query<{ status: string }>(
          `select status from public.ombudsman_manifestations
           where id=$1 and tenant_id=$2 for update`,
          [data.manifestation_id, data.tenant_id],
        )
      ).rows[0];
      if (!manifestation) throw new Error("Manifestação não encontrada");
      if (manifestation.status !== "respondida")
        throw new Error("Só uma manifestação respondida pode ser avaliada");

      const dup = await client.query(
        `select id from public.ombudsman_satisfaction
         where tenant_id=$1 and manifestation_id=$2`,
        [data.tenant_id, data.manifestation_id],
      );
      if (dup.rows.length) throw new Error("Manifestação já foi avaliada");

      const id = randomUUID();
      await client.query(
        `insert into public.ombudsman_satisfaction
           (id, tenant_id, manifestation_id, nota, comentario, avaliado_em, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          data.tenant_id,
          data.manifestation_id,
          data.nota,
          data.comentario ?? null,
          data.avaliado_em,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "rate_manifestation",
        resource: "ombudsman_satisfaction",
        recordId: id,
        after: { nota: data.nota },
      });
      return { id, nota: data.nota };
    });
  });
