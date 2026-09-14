// O2-23 — Contingenciamento / limitação de empenho (Onda 2, LRF art. 9). Bloqueia ou
// libera parte de uma dotação, reduzindo/aumentando o saldo empenhável sem alterar o
// valor orçado. O bloqueio nunca invade o já empenhado (empenhado + bloqueado ≤ orçado);
// a liberação nunca deixa o bloqueado negativo. Reusa budget.*.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const Input = z.object({
  tenant_id: z.string().uuid(),
  appropriation_id: z.string().uuid(),
  valor: z.number().positive().max(1_000_000_000_000),
  motivo: z.string().trim().min(3).max(500),
});

// Contingencia (bloqueia) parte da dotação. O bloqueio nunca invade o já empenhado.
export const contingenciarDotacao = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(Input, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const dot = (
        await client.query<{
          valor_orcado: string;
          valor_empenhado: string;
          valor_bloqueado: string;
          status: string;
        }>(
          `select valor_orcado::text, valor_empenhado::text,
             valor_bloqueado::text, status
           from public.budget_appropriations
           where id=$1 and tenant_id=$2 for update`,
          [data.appropriation_id, data.tenant_id],
        )
      ).rows[0];
      if (!dot) throw new Error("Dotação não encontrada");
      if (dot.status !== "ativa")
        throw new Error("Só uma dotação ativa pode ser contingenciada");
      const orcado = Number(dot.valor_orcado);
      const empenhado = Number(dot.valor_empenhado);
      const bloqueado = Number(dot.valor_bloqueado);
      // O contingenciamento não pode invadir o saldo já empenhado.
      if (empenhado + bloqueado + data.valor > orcado + 0.005)
        throw new Error(
          `Bloqueio (${data.valor.toFixed(2)}) invadiria o empenhado (livre ${(orcado - empenhado - bloqueado).toFixed(2)})`,
        );
      const novoBloqueado = Number((bloqueado + data.valor).toFixed(2));
      await client.query(
        `update public.budget_appropriations
         set valor_bloqueado=$3, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.appropriation_id, data.tenant_id, novoBloqueado],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "contingenciar",
        resource: "budget_appropriations",
        recordId: data.appropriation_id,
        after: { valor: data.valor, valor_bloqueado: novoBloqueado },
      });
      return { id: data.appropriation_id, valor_bloqueado: novoBloqueado };
    });
  });

// Descontingencia (libera) parte do bloqueio. Nunca deixa o bloqueado negativo.
export const descontingenciarDotacao = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(Input, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const dot = (
        await client.query<{ valor_bloqueado: string }>(
          `select valor_bloqueado::text from public.budget_appropriations
           where id=$1 and tenant_id=$2 for update`,
          [data.appropriation_id, data.tenant_id],
        )
      ).rows[0];
      if (!dot) throw new Error("Dotação não encontrada");
      const bloqueado = Number(dot.valor_bloqueado);
      if (data.valor > bloqueado + 0.005)
        throw new Error(
          `Liberação (${data.valor.toFixed(2)}) excede o bloqueado (${bloqueado.toFixed(2)})`,
        );
      const novoBloqueado = Number((bloqueado - data.valor).toFixed(2));
      await client.query(
        `update public.budget_appropriations
         set valor_bloqueado=$3, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.appropriation_id, data.tenant_id, novoBloqueado],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "descontingenciar",
        resource: "budget_appropriations",
        recordId: data.appropriation_id,
        after: { valor: data.valor, valor_bloqueado: novoBloqueado },
      });
      return { id: data.appropriation_id, valor_bloqueado: novoBloqueado };
    });
  });
