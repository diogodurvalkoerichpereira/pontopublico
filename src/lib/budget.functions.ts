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
import { contabilizarEvento } from "./accounting.functions";

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
      valor_bloqueado: string;
      saldo: string;
      status: "ativa" | "bloqueada" | "encerrada";
    }>(
      `select id, exercicio, unidade_orcamentaria, funcao, subfuncao, programa,
         acao, natureza_despesa, fonte_recurso,
         valor_orcado::text, valor_empenhado::text, valor_bloqueado::text,
         (valor_orcado - valor_empenhado - valor_bloqueado)::text as saldo, status
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

const ExecutionInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
});

// O2-07 — Balanço da execução orçamentária da despesa (Lei 4.320): por dotação,
// orçado × empenhado × liquidado × pago × saldo × restos a pagar. Empenho anulado
// não conta. Restos a pagar = empenhado não pago (processados = liquidados não
// pagos; não processados = empenhados ainda não liquidados).
export const getBudgetExecution = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ExecutionInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    const rows = await query<{
      appropriation_id: string;
      unidade_orcamentaria: string;
      natureza_despesa: string;
      valor_orcado: string;
      empenhado: string;
      liquidado: string;
      pago: string;
      saldo_dotacao: string;
      restos_a_pagar: string;
    }>(
      `select a.id as appropriation_id, a.unidade_orcamentaria, a.natureza_despesa,
         a.valor_orcado::text,
         coalesce(sum(c.valor) filter (where c.status <> 'anulado'),0)::text as empenhado,
         coalesce(sum(c.valor) filter (where c.status in ('liquidado','pago')),0)::text as liquidado,
         coalesce(sum(c.valor) filter (where c.status = 'pago'),0)::text as pago,
         (a.valor_orcado - coalesce(sum(c.valor) filter (where c.status <> 'anulado'),0))::text as saldo_dotacao,
         coalesce(sum(c.valor) filter (where c.status in ('empenhado','liquidado')),0)::text as restos_a_pagar
       from public.budget_appropriations a
       left join public.budget_commitments c on c.appropriation_id = a.id
       where a.tenant_id = $1 and a.exercicio = $2
       group by a.id, a.unidade_orcamentaria, a.natureza_despesa, a.valor_orcado
       order by a.unidade_orcamentaria, a.natureza_despesa`,
      [data.tenant_id, data.exercicio],
    );
    const totais = rows.reduce(
      (acc, r) => ({
        orcado: acc.orcado + Number(r.valor_orcado),
        empenhado: acc.empenhado + Number(r.empenhado),
        liquidado: acc.liquidado + Number(r.liquidado),
        pago: acc.pago + Number(r.pago),
        restos_a_pagar: acc.restos_a_pagar + Number(r.restos_a_pagar),
      }),
      { orcado: 0, empenhado: 0, liquidado: 0, pago: 0, restos_a_pagar: 0 },
    );
    return {
      rows,
      totais: {
        orcado: Number(totais.orcado.toFixed(2)),
        empenhado: Number(totais.empenhado.toFixed(2)),
        liquidado: Number(totais.liquidado.toFixed(2)),
        pago: Number(totais.pago.toFixed(2)),
        restos_a_pagar: Number(totais.restos_a_pagar.toFixed(2)),
      },
    };
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

// Núcleo do empenho: reserva `valor` no saldo da dotação, atômico. Nunca acima do
// saldo (orçado - empenhado). Numeração serializada por um contador do exercício
// travado FOR UPDATE (molde do NSR do ponto). Reusado pelo empenho manual e pelo
// empenho da folha (O2-04). A transação é do chamador.
type ReserveParams = {
  client: import("pg").PoolClient;
  tenantId: string;
  appropriationId: string;
  dataEmpenho: string;
  tipo: "ordinario" | "global" | "estimativo";
  credor: string;
  historico: string;
  valor: number;
  source: "manual" | "folha" | "contrato";
  sourceRef?: string | null;
  actorId: string;
};

async function reserveOnAppropriation(params: ReserveParams) {
  const { client } = params;
  const appropriation = (
    await client.query<{
      exercicio: number;
      valor_orcado: string;
      valor_empenhado: string;
      valor_bloqueado: string;
      status: string;
    }>(
      `select exercicio, valor_orcado::text, valor_empenhado::text,
         valor_bloqueado::text, status
       from public.budget_appropriations
       where id = $1 and tenant_id = $2 for update`,
      [params.appropriationId, params.tenantId],
    )
  ).rows[0];
  if (!appropriation) throw new Error("Dotação não encontrada");
  if (appropriation.status !== "ativa")
    throw new Error("Dotação não está ativa para empenho");
  // Saldo empenhável desconta o contingenciado (LRF art. 9).
  const saldo =
    Number(appropriation.valor_orcado) -
    Number(appropriation.valor_empenhado) -
    Number(appropriation.valor_bloqueado);
  if (params.valor > saldo)
    throw new Error(
      `Valor do empenho (${params.valor.toFixed(2)}) excede o saldo da dotação (${saldo.toFixed(2)})`,
    );

  await client.query(
    `insert into public.budget_commitment_counters (tenant_id, exercicio)
     values ($1, $2) on conflict do nothing`,
    [params.tenantId, appropriation.exercicio],
  );
  const counter = (
    await client.query<{ last_numero: string }>(
      `select last_numero::text from public.budget_commitment_counters
       where tenant_id = $1 and exercicio = $2 for update`,
      [params.tenantId, appropriation.exercicio],
    )
  ).rows[0];
  const numero = Number(counter.last_numero) + 1;
  await client.query(
    `update public.budget_commitment_counters set last_numero = $3
     where tenant_id = $1 and exercicio = $2`,
    [params.tenantId, appropriation.exercicio, numero],
  );

  const id = randomUUID();
  await client.query(
    `insert into public.budget_commitments
       (id, tenant_id, appropriation_id, exercicio, numero, data_empenho,
        tipo, credor, historico, valor, status, source, source_ref, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'empenhado',$11,$12,$13)`,
    [
      id,
      params.tenantId,
      params.appropriationId,
      appropriation.exercicio,
      numero,
      params.dataEmpenho,
      params.tipo,
      params.credor,
      params.historico,
      params.valor,
      params.source,
      params.sourceRef ?? null,
      params.actorId,
    ],
  );
  await client.query(
    `update public.budget_appropriations
     set valor_empenhado = valor_empenhado + $3, updated_at = now()
     where id = $1 and tenant_id = $2`,
    [params.appropriationId, params.tenantId, params.valor],
  );
  // Contabilização automática do empenho (se o ente configurou o roteiro).
  await contabilizarEvento({
    client,
    tenantId: params.tenantId,
    exercicio: appropriation.exercicio,
    dataLancamento: params.dataEmpenho,
    eventCode: "empenho",
    valor: params.valor,
    historico: `Empenho nº ${numero} — ${params.credor}`,
    sourceRef: id,
    actorId: params.actorId,
  });
  await recordAudit(client, {
    tenantId: params.tenantId,
    actorId: params.actorId,
    action: "commit",
    resource: "budget_commitments",
    recordId: id,
    after: {
      appropriation_id: params.appropriationId,
      numero,
      valor: params.valor,
      credor: params.credor,
      source: params.source,
    },
  });
  return { id, numero };
}

export const createBudgetCommitment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CommitInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction((client) =>
      reserveOnAppropriation({
        client,
        tenantId: data.tenant_id,
        appropriationId: data.appropriation_id,
        dataEmpenho: data.data_empenho,
        tipo: data.tipo,
        credor: data.credor,
        historico: data.historico,
        valor: data.valor,
        source: "manual",
        actorId: context.userId,
      }),
    );
  });

const CommitPayrollInput = z.object({
  tenant_id: z.string().uuid(),
  request_id: z.string().uuid(),
  data_empenho: z.string().date(),
  // Cada linha da requisição (por natureza) empenhada contra uma dotação.
  allocations: z
    .array(
      z.object({
        line_id: z.string().uuid(),
        appropriation_id: z.string().uuid(),
      }),
    )
    .min(1)
    .max(200),
});

// O2-04 — folha → orçamento: transforma a requisição de empenho da folha (O1-08)
// em empenhos reais contra dotação, um por linha (natureza), reservando saldo.
// Exige que TODA linha seja alocada; idempotente (a requisição vira 'empenhada').
export const commitPayrollEmpenho = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CommitPayrollInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const request = (
        await client.query<{
          status: string;
          reference_month: string;
        }>(
          `select status, reference_month::text from public.payroll_empenho_requests
           where id = $1 and tenant_id = $2 for update`,
          [data.request_id, data.tenant_id],
        )
      ).rows[0];
      if (!request) throw new Error("Requisição de empenho não encontrada");
      if (request.status === "empenhada")
        throw new Error("Requisição já foi empenhada");
      if (request.status !== "emitida")
        throw new Error("Só uma requisição emitida pode ser empenhada");

      const lines = (
        await client.query<{
          id: string;
          natureza_despesa: string;
          description: string;
          amount: string;
        }>(
          `select id, natureza_despesa, description, amount::text
           from public.payroll_empenho_request_lines
           where request_id = $1 and tenant_id = $2`,
          [data.request_id, data.tenant_id],
        )
      ).rows;
      const allocByLine = new Map(
        data.allocations.map((a) => [a.line_id, a.appropriation_id]),
      );
      if (
        allocByLine.size !== data.allocations.length ||
        lines.length !== allocByLine.size ||
        !lines.every((line) => allocByLine.has(line.id))
      )
        throw new Error(
          "Cada linha da requisição deve ser alocada a exatamente uma dotação",
        );

      const commitments: Array<{ id: string; numero: number }> = [];
      for (const line of lines) {
        const result = await reserveOnAppropriation({
          client,
          tenantId: data.tenant_id,
          appropriationId: allocByLine.get(line.id)!,
          dataEmpenho: data.data_empenho,
          tipo: "ordinario",
          credor: "Folha de pagamento",
          historico: `Folha ${request.reference_month.slice(0, 7)} — ${line.description}`,
          valor: Number(line.amount),
          source: "folha",
          sourceRef: data.request_id,
          actorId: context.userId,
        });
        commitments.push(result);
      }

      await client.query(
        `update public.payroll_empenho_requests set status = 'empenhada'
         where id = $1 and tenant_id = $2`,
        [data.request_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "commit_payroll_empenho",
        resource: "payroll_empenho_requests",
        recordId: data.request_id,
        after: { commitments: commitments.length },
      });
      return { commitments };
    });
  });

const CommitContractInput = z.object({
  tenant_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  appropriation_id: z.string().uuid(),
  data_empenho: z.string().date(),
  tipo: z.enum(["ordinario", "global", "estimativo"]).default("global"),
  valor: z.number().positive().max(1_000_000_000_000),
});

// O3-04 — contrato → orçamento: emite empenho real contra dotação para uma
// parcela do contrato (O3-01), reservando saldo pelo mesmo primitivo da folha
// (O2-04). Nunca acima do saldo do contrato (valor_total - valor_empenhado);
// um contrato pode ser empenhado em várias parcelas (exercícios/exec. diferentes).
export const commitContractEmpenho = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CommitContractInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const contract = (
        await client.query<{
          numero: string;
          ano: number;
          fornecedor: string;
          objeto: string;
          status: string;
          valor_total: string;
          valor_empenhado: string;
        }>(
          `select numero, ano, fornecedor, objeto, status,
             valor_total::text, valor_empenhado::text
           from public.procurement_contracts
           where id = $1 and tenant_id = $2 for update`,
          [data.contract_id, data.tenant_id],
        )
      ).rows[0];
      if (!contract) throw new Error("Contrato não encontrado");
      if (contract.status !== "vigente")
        throw new Error("Só um contrato vigente pode ser empenhado");
      const saldoContrato =
        Number(contract.valor_total) - Number(contract.valor_empenhado);
      if (data.valor > saldoContrato)
        throw new Error(
          `Valor do empenho (${data.valor.toFixed(2)}) excede o saldo do contrato (${saldoContrato.toFixed(2)})`,
        );

      const result = await reserveOnAppropriation({
        client,
        tenantId: data.tenant_id,
        appropriationId: data.appropriation_id,
        dataEmpenho: data.data_empenho,
        tipo: data.tipo,
        credor: contract.fornecedor,
        historico: `Contrato nº ${contract.numero}/${contract.ano} — ${contract.objeto}`,
        valor: data.valor,
        source: "contrato",
        sourceRef: data.contract_id,
        actorId: context.userId,
      });

      await client.query(
        `update public.procurement_contracts
         set valor_empenhado = valor_empenhado + $3, updated_at = now()
         where id = $1 and tenant_id = $2`,
        [data.contract_id, data.tenant_id, data.valor],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "commit_contract_empenho",
        resource: "procurement_contracts",
        recordId: data.contract_id,
        after: {
          commitment_id: result.id,
          numero: result.numero,
          valor: data.valor,
        },
      });
      return result;
    });
  });

const PartialCancelInput = z.object({
  tenant_id: z.string().uuid(),
  commitment_id: z.string().uuid(),
  novo_valor: z.number().positive().max(1_000_000_000_000),
  motivo: z.string().trim().min(3).max(500),
});

// O2-03b — Anulação parcial de empenho (Lei 4.320 art. 59). Reduz o valor de um empenho
// ainda no estágio 'empenhado' (antes de liquidar) e devolve a diferença ao saldo da
// dotação (e ao contrato, se for empenho de contrato), contabilizando a anulação parcial.
// O novo valor tem de ser menor que o atual e maior que zero. Reusa budget.manage.
export const partiallyCancelBudgetCommitment = createServerFn({
  method: "POST",
})
  .middleware([requireAuth])
  .validator((data: unknown) => PartialCancelInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const commitment = (
        await client.query<{
          status: string;
          appropriation_id: string;
          valor: string;
          exercicio: number;
          source: string;
          source_ref: string | null;
        }>(
          `select status, appropriation_id, valor::text, exercicio, source, source_ref
           from public.budget_commitments
           where id = $1 and tenant_id = $2 for update`,
          [data.commitment_id, data.tenant_id],
        )
      ).rows[0];
      if (!commitment) throw new Error("Empenho não encontrado");
      if (commitment.status !== "empenhado")
        throw new Error(
          "Só um empenho no estágio 'empenhado' admite anulação parcial",
        );
      const atual = Number(commitment.valor);
      if (data.novo_valor >= atual)
        throw new Error("O novo valor deve ser menor que o valor empenhado");
      const diferenca = Number((atual - data.novo_valor).toFixed(2));

      // Devolve a diferença ao saldo da dotação (lock antes de escrever).
      await client.query(
        `select id from public.budget_appropriations
         where id = $1 and tenant_id = $2 for update`,
        [commitment.appropriation_id, data.tenant_id],
      );
      await client.query(
        `update public.budget_appropriations
         set valor_empenhado = valor_empenhado - $3, updated_at = now()
         where id = $1 and tenant_id = $2`,
        [commitment.appropriation_id, data.tenant_id, diferenca],
      );
      // Empenho de contrato: devolve também a diferença reservada no contrato.
      if (commitment.source === "contrato" && commitment.source_ref) {
        await client.query(
          `select id from public.procurement_contracts
           where id = $1 and tenant_id = $2 for update`,
          [commitment.source_ref, data.tenant_id],
        );
        await client.query(
          `update public.procurement_contracts
           set valor_empenhado = valor_empenhado - $3, updated_at = now()
           where id = $1 and tenant_id = $2`,
          [commitment.source_ref, data.tenant_id, diferenca],
        );
      }
      await client.query(
        `update public.budget_commitments
         set valor = $3
         where id = $1 and tenant_id = $2`,
        [data.commitment_id, data.tenant_id, data.novo_valor],
      );
      await contabilizarEvento({
        client,
        tenantId: data.tenant_id,
        exercicio: commitment.exercicio,
        dataLancamento: new Date().toISOString().slice(0, 10),
        eventCode: "empenho_anulacao",
        valor: diferenca,
        historico: "Anulação parcial de empenho",
        sourceRef: data.commitment_id,
        actorId: context.userId,
      });
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "anular_parcial",
        resource: "budget_commitments",
        recordId: data.commitment_id,
        before: { valor: atual },
        after: {
          valor: data.novo_valor,
          devolvido: diferenca,
          motivo: data.motivo,
        },
      });
      return {
        id: data.commitment_id,
        valor: data.novo_valor,
        devolvido: diferenca,
      };
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
          exercicio: number;
          source: string;
          source_ref: string | null;
        }>(
          `select status, appropriation_id, valor::text, exercicio, source, source_ref
           from public.budget_commitments
           where id = $1 and tenant_id = $2 for update`,
          [data.commitment_id, data.tenant_id],
        )
      ).rows[0];
      if (!commitment) throw new Error("Empenho não encontrado");
      const hoje = new Date().toISOString().slice(0, 10);

      if (data.action === "liquidar") {
        if (commitment.status !== "empenhado")
          throw new Error("Só um empenho no estágio 'empenhado' pode liquidar");
        await client.query(
          `update public.budget_commitments
           set status = 'liquidado', liquidado_em = now(), liquidado_por = $3
           where id = $1 and tenant_id = $2`,
          [data.commitment_id, data.tenant_id, context.userId],
        );
        await contabilizarEvento({
          client,
          tenantId: data.tenant_id,
          exercicio: commitment.exercicio,
          dataLancamento: hoje,
          eventCode: "liquidacao",
          valor: Number(commitment.valor),
          historico: "Liquidação de empenho",
          sourceRef: data.commitment_id,
          actorId: context.userId,
        });
      } else if (data.action === "pagar") {
        if (commitment.status !== "liquidado")
          throw new Error("Só um empenho liquidado pode ser pago");
        await client.query(
          `update public.budget_commitments
           set status = 'pago', pago_em = now(), pago_por = $3
           where id = $1 and tenant_id = $2`,
          [data.commitment_id, data.tenant_id, context.userId],
        );
        await contabilizarEvento({
          client,
          tenantId: data.tenant_id,
          exercicio: commitment.exercicio,
          dataLancamento: hoje,
          eventCode: "pagamento",
          valor: Number(commitment.valor),
          historico: "Pagamento de empenho",
          sourceRef: data.commitment_id,
          actorId: context.userId,
        });
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
        // Empenho de contrato (O3-04): devolve também o saldo reservado no contrato.
        if (commitment.source === "contrato" && commitment.source_ref) {
          await client.query(
            `select id from public.procurement_contracts
             where id = $1 and tenant_id = $2 for update`,
            [commitment.source_ref, data.tenant_id],
          );
          await client.query(
            `update public.procurement_contracts
             set valor_empenhado = valor_empenhado - $3, updated_at = now()
             where id = $1 and tenant_id = $2`,
            [commitment.source_ref, data.tenant_id, commitment.valor],
          );
        }
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
        await contabilizarEvento({
          client,
          tenantId: data.tenant_id,
          exercicio: commitment.exercicio,
          dataLancamento: hoje,
          eventCode: "empenho_anulacao",
          valor: Number(commitment.valor),
          historico: "Anulação de empenho",
          sourceRef: data.commitment_id,
          actorId: context.userId,
        });
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
