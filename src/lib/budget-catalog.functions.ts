// O2-35 — Catálogo de classificação orçamentária: função, subfunção, natureza da
// despesa e fonte de recurso. Antes eram campo livre, digitados de cabeça em toda
// dotação — erro de digitação virava classificação inexistente, e o mesmo código
// entrava com grafias diferentes ("3.1.90.11" e "319011"), que o agrupamento dos
// relatórios trata como coisas distintas.
//
// O catálogo tem duas camadas: as linhas com `tenant_id` nulo são o padrão
// nacional que acompanha o sistema; as do ente são acréscimos dele. É catálogo de
// REFERÊNCIA, não declaração de conformidade — o Tribunal de Contas do ente pode
// exigir detalhamento próprio, em especial na fonte de recurso.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const TIPOS = [
  "funcao",
  "subfuncao",
  "natureza_categoria",
  "natureza_grupo",
  "natureza_modalidade",
  "natureza_elemento",
  "fonte_recurso",
] as const;

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  tipo: z.enum(TIPOS).optional(),
});

export const getBudgetCatalog = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(GetInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    const codigos = await query<{
      id: string;
      tipo: string;
      codigo: string;
      nome: string;
      proprio: boolean;
    }>(
      `select id, tipo, codigo, nome, (tenant_id is not null) as proprio
       from public.budget_reference_codes
       where (tenant_id is null or tenant_id = $1)
         and ativo
         and ($2::text is null or tipo = $2)
       order by tipo, codigo`,
      [data.tenant_id, data.tipo ?? null],
    );
    return {
      codigos: codigos.map((c) => ({ ...c, proprio: Boolean(c.proprio) })),
      canManage: access.permissions.includes("budget.manage"),
    };
  });

const SaveInput = z.object({
  tenant_id: z.string().uuid(),
  tipo: z.enum(TIPOS),
  codigo: z.string().trim().min(1).max(20),
  nome: z.string().trim().min(2).max(200),
});

// Acrescenta um código ao catálogo DO ENTE. O padrão nacional (tenant_id nulo)
// não é editável por aqui: se o ente precisa de outro nome para o mesmo código,
// cadastra o dele — o próprio prevalece na tela.
export const saveBudgetCatalogCode = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    const existente = await queryOne<{ id: string }>(
      `select id from public.budget_reference_codes
       where tenant_id = $1 and tipo = $2 and codigo = $3`,
      [data.tenant_id, data.tipo, data.codigo],
    );
    return withTransaction(async (client) => {
      if (existente) {
        await client.query(
          `update public.budget_reference_codes
           set nome = $2, ativo = true where id = $1`,
          [existente.id, data.nome],
        );
      } else {
        await client.query(
          `insert into public.budget_reference_codes
             (tenant_id, tipo, codigo, nome)
           values ($1,$2,$3,$4)`,
          [data.tenant_id, data.tipo, data.codigo, data.nome],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: existente ? "update" : "create",
        resource: "budget_reference_codes",
        recordId: existente?.id ?? null,
        after: { tipo: data.tipo, codigo: data.codigo, nome: data.nome },
      });
      return { tipo: data.tipo, codigo: data.codigo };
    });
  });
