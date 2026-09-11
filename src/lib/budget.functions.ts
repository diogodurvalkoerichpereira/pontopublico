// O2-01 — Dotação orçamentária (núcleo SIAFIC). Espelha o padrão de
// fiscal-tables/pension-regimes: createServerFn + loadTenantAccess +
// requireTenantPermission, dedup pela chave orçamentária, auditado. O
// valor_empenhado é gerido pela reserva do empenho (incremento futuro), não por
// este write-path — aqui só o orçado e a classificação.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200).optional(),
});

export const getBudgetAppropriations = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    const appropriations = await query<{
      id: string;
      exercicio: number;
      unidade_orcamentaria: string;
      funcao: string;
      subfuncao: string;
      programa: string;
      acao: string;
      natureza_despesa: string;
      fonte_recurso: string;
      valor_orcado: string;
      valor_empenhado: string;
      saldo: string;
      status: "ativa" | "bloqueada" | "encerrada";
    }>(
      `select id, exercicio, unidade_orcamentaria, funcao, subfuncao, programa,
         acao, natureza_despesa, fonte_recurso,
         valor_orcado::text, valor_empenhado::text,
         (valor_orcado - valor_empenhado)::text as saldo, status
       from public.budget_appropriations
       where tenant_id = $1 and ($2::int is null or exercicio = $2)
       order by exercicio desc, unidade_orcamentaria, natureza_despesa`,
      [data.tenant_id, data.exercicio ?? null],
    );
    return {
      appropriations,
      canManage: access.permissions.includes("budget.manage"),
    };
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
  unidade_orcamentaria: z.string().trim().min(1).max(60),
  funcao: z.string().trim().min(1).max(20),
  subfuncao: z.string().trim().min(1).max(20),
  programa: z.string().trim().min(1).max(20),
  acao: z.string().trim().min(1).max(20),
  natureza_despesa: z
    .string()
    .trim()
    .regex(/^[0-9.]{4,20}$/, "Natureza de despesa inválida"),
  fonte_recurso: z.string().trim().min(1).max(60),
  valor_orcado: z.number().min(0).max(1_000_000_000_000),
  status: z.enum(["ativa", "bloqueada", "encerrada"]).default("ativa"),
});

export const saveBudgetAppropriation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    // Uma dotação por classificação orçamentária completa no exercício.
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.budget_appropriations
       where tenant_id = $1 and exercicio = $2 and unidade_orcamentaria = $3
         and funcao = $4 and subfuncao = $5 and programa = $6 and acao = $7
         and natureza_despesa = $8 and fonte_recurso = $9
         and ($10::uuid is null or id <> $10)`,
      [
        data.tenant_id,
        data.exercicio,
        data.unidade_orcamentaria,
        data.funcao,
        data.subfuncao,
        data.programa,
        data.acao,
        data.natureza_despesa,
        data.fonte_recurso,
        data.id ?? null,
      ],
    );
    if (duplicate)
      throw new Error("Já existe dotação com esta classificação no exercício");

    const before = data.id
      ? await queryOne<{ valor_empenhado: string }>(
          "select valor_empenhado::text from public.budget_appropriations where id = $1 and tenant_id = $2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Dotação não encontrada");
    // Não se pode orçar abaixo do que já foi empenhado (saldo ficaria negativo).
    if (before && data.valor_orcado < Number(before.valor_empenhado))
      throw new Error(
        "Valor orçado não pode ser menor que o já empenhado na dotação",
      );

    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.budget_appropriations set
             exercicio = $3, unidade_orcamentaria = $4, funcao = $5,
             subfuncao = $6, programa = $7, acao = $8, natureza_despesa = $9,
             fonte_recurso = $10, valor_orcado = $11, status = $12,
             updated_at = now()
           where id = $1 and tenant_id = $2`,
          [
            id,
            data.tenant_id,
            data.exercicio,
            data.unidade_orcamentaria,
            data.funcao,
            data.subfuncao,
            data.programa,
            data.acao,
            data.natureza_despesa,
            data.fonte_recurso,
            data.valor_orcado,
            data.status,
          ],
        );
      } else {
        await client.query(
          `insert into public.budget_appropriations
             (id, tenant_id, exercicio, unidade_orcamentaria, funcao, subfuncao,
              programa, acao, natureza_despesa, fonte_recurso, valor_orcado,
              status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            data.tenant_id,
            data.exercicio,
            data.unidade_orcamentaria,
            data.funcao,
            data.subfuncao,
            data.programa,
            data.acao,
            data.natureza_despesa,
            data.fonte_recurso,
            data.valor_orcado,
            data.status,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "budget_appropriations",
        recordId: id,
        before: before ?? null,
        after: data,
      });
    });
    return { id };
  });
