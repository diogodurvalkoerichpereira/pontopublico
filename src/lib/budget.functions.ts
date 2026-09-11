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

const GetCommitmentsInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200).optional(),
});

export const getBudgetCommitments = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetCommitmentsInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    return query<{
      id: string;
      exercicio: number;
      numero: string;
      data_empenho: string;
      tipo: string;
      credor: string;
      historico: string;
      valor: string;
      status: string;
      source: string;
      natureza_despesa: string;
      unidade_orcamentaria: string;
    }>(
      `select c.id, c.exercicio, c.numero::text, c.data_empenho::text, c.tipo,
         c.credor, c.historico, c.valor::text, c.status, c.source,
         a.natureza_despesa, a.unidade_orcamentaria
       from public.budget_commitments c
       join public.budget_appropriations a on a.id = c.appropriation_id
       where c.tenant_id = $1 and ($2::int is null or c.exercicio = $2)
       order by c.exercicio desc, c.numero desc`,
      [data.tenant_id, data.exercicio ?? null],
    );
  });

const CommitInput = z.object({
  tenant_id: z.string().uuid(),
  appropriation_id: z.string().uuid(),
  data_empenho: z.string().date(),
  tipo: z.enum(["ordinario", "global", "estimativo"]).default("ordinario"),
  credor: z.string().trim().min(2).max(200),
  historico: z.string().trim().min(3).max(500),
  valor: z.number().positive().max(1_000_000_000_000),
});

// Empenha: reserva `valor` no saldo da dotação, atômico. Nunca acima do saldo
// (orçado - empenhado). Numeração serializada por um contador do exercício
// travado FOR UPDATE (molde do NSR do ponto).
export const createBudgetCommitment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CommitInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const appropriation = (
        await client.query<{
          exercicio: number;
          valor_orcado: string;
          valor_empenhado: string;
          status: string;
        }>(
          `select exercicio, valor_orcado::text, valor_empenhado::text, status
           from public.budget_appropriations
           where id = $1 and tenant_id = $2 for update`,
          [data.appropriation_id, data.tenant_id],
        )
      ).rows[0];
      if (!appropriation) throw new Error("Dotação não encontrada");
      if (appropriation.status !== "ativa")
        throw new Error("Dotação não está ativa para empenho");
      const saldo =
        Number(appropriation.valor_orcado) -
        Number(appropriation.valor_empenhado);
      if (data.valor > saldo)
        throw new Error(
          `Valor do empenho (${data.valor.toFixed(2)}) excede o saldo da dotação (${saldo.toFixed(2)})`,
        );

      await client.query(
        `insert into public.budget_commitment_counters (tenant_id, exercicio)
         values ($1, $2) on conflict do nothing`,
        [data.tenant_id, appropriation.exercicio],
      );
      const counter = (
        await client.query<{ last_numero: string }>(
          `select last_numero::text from public.budget_commitment_counters
           where tenant_id = $1 and exercicio = $2 for update`,
          [data.tenant_id, appropriation.exercicio],
        )
      ).rows[0];
      const numero = Number(counter.last_numero) + 1;
      await client.query(
        `update public.budget_commitment_counters set last_numero = $3
         where tenant_id = $1 and exercicio = $2`,
        [data.tenant_id, appropriation.exercicio, numero],
      );

      const id = randomUUID();
      await client.query(
        `insert into public.budget_commitments
           (id, tenant_id, appropriation_id, exercicio, numero, data_empenho,
            tipo, credor, historico, valor, status, source, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'empenhado','manual',$11)`,
        [
          id,
          data.tenant_id,
          data.appropriation_id,
          appropriation.exercicio,
          numero,
          data.data_empenho,
          data.tipo,
          data.credor,
          data.historico,
          data.valor,
          context.userId,
        ],
      );
      await client.query(
        `update public.budget_appropriations
         set valor_empenhado = valor_empenhado + $3, updated_at = now()
         where id = $1 and tenant_id = $2`,
        [data.appropriation_id, data.tenant_id, data.valor],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "commit",
        resource: "budget_commitments",
        recordId: id,
        after: {
          appropriation_id: data.appropriation_id,
          numero,
          valor: data.valor,
          credor: data.credor,
        },
      });
      return { id, numero };
    });
  });

const TransitionInput = z.object({
  tenant_id: z.string().uuid(),
  commitment_id: z.string().uuid(),
  action: z.enum(["liquidar", "pagar", "anular"]),
  motivo: z.string().trim().max(500).optional(),
});

// Estágios da despesa (Lei 4.320): empenhado -> liquidado -> pago. Anular devolve
// o saldo reservado à dotação. Molde de transitionPayrollCycle (lock + valida o
// estado de origem + carimba o marco).
export const transitionBudgetCommitment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TransitionInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const commitment = (
        await client.query<{
          status: string;
          appropriation_id: string;
          valor: string;
        }>(
          `select status, appropriation_id, valor::text
           from public.budget_commitments
           where id = $1 and tenant_id = $2 for update`,
          [data.commitment_id, data.tenant_id],
        )
      ).rows[0];
      if (!commitment) throw new Error("Empenho não encontrado");

      if (data.action === "liquidar") {
        if (commitment.status !== "empenhado")
          throw new Error("Só um empenho no estágio 'empenhado' pode liquidar");
        await client.query(
          `update public.budget_commitments
           set status = 'liquidado', liquidado_em = now(), liquidado_por = $3
           where id = $1 and tenant_id = $2`,
          [data.commitment_id, data.tenant_id, context.userId],
        );
      } else if (data.action === "pagar") {
        if (commitment.status !== "liquidado")
          throw new Error("Só um empenho liquidado pode ser pago");
        await client.query(
          `update public.budget_commitments
           set status = 'pago', pago_em = now(), pago_por = $3
           where id = $1 and tenant_id = $2`,
          [data.commitment_id, data.tenant_id, context.userId],
        );
      } else {
        // anular
        if (commitment.status === "pago")
          throw new Error("Empenho pago não pode ser anulado");
        if (commitment.status === "anulado")
          throw new Error("Empenho já está anulado");
        // Devolve o saldo reservado à dotação (lock antes de escrever).
        await client.query(
          `select id from public.budget_appropriations
           where id = $1 and tenant_id = $2 for update`,
          [commitment.appropriation_id, data.tenant_id],
        );
        await client.query(
          `update public.budget_appropriations
           set valor_empenhado = valor_empenhado - $3, updated_at = now()
           where id = $1 and tenant_id = $2`,
          [commitment.appropriation_id, data.tenant_id, commitment.valor],
        );
        await client.query(
          `update public.budget_commitments
           set status = 'anulado', anulado_em = now(), anulado_por = $3,
               anulado_motivo = $4
           where id = $1 and tenant_id = $2`,
          [
            data.commitment_id,
            data.tenant_id,
            context.userId,
            data.motivo ?? null,
          ],
        );
      }

      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.action,
        resource: "budget_commitments",
        recordId: data.commitment_id,
        before: { status: commitment.status },
        after: { action: data.action, motivo: data.motivo ?? null },
      });
      return { id: data.commitment_id, action: data.action };
    });
  });
