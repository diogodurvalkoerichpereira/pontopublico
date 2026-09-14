// O5-08 — Indicador de tempestividade das respostas (Onda 5, Lei 13.460 / LAI). Consolida
// quantas manifestações da ouvidoria e quantos pedidos de e-SIC foram respondidos dentro
// do prazo legal (data da resposta ≤ prazo), com o percentual no prazo. Base de
// transparência ativa do desempenho do atendimento. Read-only, reusa protocol.read.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { queryOne } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const Input = z.object({ tenant_id: z.string().uuid() });

function resumo(respondidas: number, noPrazo: number) {
  const fora = respondidas - noPrazo;
  const percentual =
    respondidas > 0 ? Number(((noPrazo / respondidas) * 100).toFixed(2)) : 0;
  return { respondidas, no_prazo: noPrazo, fora_prazo: fora, percentual };
}

export const getResponseTimeliness = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(Input, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "protocol.read");

    // Ouvidoria: manifestações respondidas, no prazo quando respondida_em ≤ prazo.
    const ouv = await queryOne<{ respondidas: string; no_prazo: string }>(
      `select
         count(*) filter (where respondida_em is not null)::text as respondidas,
         count(*) filter (where respondida_em is not null and respondida_em <= prazo_resposta)::text as no_prazo
       from public.ombudsman_manifestations
       where tenant_id = $1`,
      [data.tenant_id],
    );

    // e-SIC: pedidos com resposta (respondido/indeferido), no prazo quando ≤ prazo.
    const esic = await queryOne<{ respondidas: string; no_prazo: string }>(
      `select
         count(*) filter (where respondido_em is not null)::text as respondidas,
         count(*) filter (where respondido_em is not null and respondido_em <= prazo_resposta)::text as no_prazo
       from public.esic_requests
       where tenant_id = $1`,
      [data.tenant_id],
    );

    return {
      ouvidoria: resumo(
        Number(ouv?.respondidas ?? 0),
        Number(ouv?.no_prazo ?? 0),
      ),
      esic: resumo(Number(esic?.respondidas ?? 0), Number(esic?.no_prazo ?? 0)),
    };
  });
