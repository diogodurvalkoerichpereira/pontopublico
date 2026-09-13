// O2-17 — Demonstração dos Fluxos de Caixa (Onda 2, MCASP/PCASP, DFC). Classifica,
// no exercício, os ingressos (receita arrecadada, líquida de estornos) e os
// desembolsos (despesa paga) em três fluxos pela NATUREZA codificada
// (1º dígito = categoria econômica; 2º = origem da receita / grupo da despesa):
//
//   Operacional   — receitas correntes (1.x, 7.x) e demais ingressos (2.4 transf.
//                   de capital, 2.9 outras) × despesas correntes (3.x, inclusive
//                   juros e encargos da dívida 3.2, como manda o MCASP).
//   Investimento  — alienação de bens (2.2) e amortização de empréstimos
//                   concedidos (2.3) × investimentos (4.4) e inversões (4.5).
//   Financiamento — operações de crédito (2.1) × amortização da dívida (4.6).
//
// A geração líquida de caixa é a soma dos três fluxos e deve explicar a variação
// do caixa da tesouraria (caixa final − caixa inicial); `conciliado` acusa quando
// não explica. Read-only, reusa budget.read (mesma audiência do balanço financeiro).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { queryOne } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const Input = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
});

const n2 = (v: number) => Number(v.toFixed(2));

export const getCashFlowStatement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");

    // Ingressos: arrecadação do exercício (sem estornadas), por origem da receita.
    // `cod` = natureza sem pontos; cod[1] = categoria, cod[1..2] = origem.
    const ingressos = await queryOne<{
      operacional: string;
      investimento: string;
      financiamento: string;
    }>(
      `with rc as (
         select regexp_replace(br.natureza_receita, '\\.', '', 'g') as cod, c.valor
         from public.revenue_collections c
         join public.budget_revenues br on br.id = c.revenue_id and br.tenant_id = c.tenant_id
         where c.tenant_id = $1 and not c.estornada
           and extract(year from c.data_arrecadacao) = $2
       )
       select
         coalesce(sum(valor) filter (where left(cod,2) not in ('21','22','23')),0)::text as operacional,
         coalesce(sum(valor) filter (where left(cod,2) in ('22','23')),0)::text as investimento,
         coalesce(sum(valor) filter (where left(cod,2) = '21'),0)::text as financiamento
       from rc`,
      [data.tenant_id, data.exercicio],
    );

    // Desembolsos: despesa paga no exercício, por grupo da natureza da despesa.
    const desembolsos = await queryOne<{
      operacional: string;
      investimento: string;
      financiamento: string;
    }>(
      `with pg as (
         select regexp_replace(a.natureza_despesa, '\\.', '', 'g') as cod, c.valor
         from public.budget_commitments c
         join public.budget_appropriations a on a.id = c.appropriation_id and a.tenant_id = c.tenant_id
         where c.tenant_id = $1 and c.exercicio = $2 and c.status = 'pago'
       )
       select
         coalesce(sum(valor) filter (where left(cod,1) = '3'),0)::text as operacional,
         coalesce(sum(valor) filter (where left(cod,1) = '4' and left(cod,2) <> '46'),0)::text as investimento,
         coalesce(sum(valor) filter (where left(cod,2) = '46'),0)::text as financiamento
       from pg`,
      [data.tenant_id, data.exercicio],
    );

    // Caixa da tesouraria: saldo antes do exercício e ao fim dele (ingressos e
    // transferências de entrada somam; saídas e transferências de saída subtraem).
    const caixa = await queryOne<{ inicial: string; final: string }>(
      `select
         coalesce(sum(case when tipo in ('ingresso','transferencia_entrada') then valor else -valor end)
           filter (where data_movimento < make_date($2::int,1,1)),0)::text as inicial,
         coalesce(sum(case when tipo in ('ingresso','transferencia_entrada') then valor else -valor end)
           filter (where data_movimento <= make_date($2::int,12,31)),0)::text as final
       from public.treasury_movements
       where tenant_id = $1`,
      [data.tenant_id, data.exercicio],
    );

    const fluxo = (ing: string | undefined, des: string | undefined) => {
      const i = Number(ing ?? 0);
      const d = Number(des ?? 0);
      return { ingressos: n2(i), desembolsos: n2(d), liquido: n2(i - d) };
    };
    const operacional = fluxo(ingressos?.operacional, desembolsos?.operacional);
    const investimento = fluxo(
      ingressos?.investimento,
      desembolsos?.investimento,
    );
    const financiamento = fluxo(
      ingressos?.financiamento,
      desembolsos?.financiamento,
    );
    const geracaoLiquida = n2(
      operacional.liquido + investimento.liquido + financiamento.liquido,
    );
    const caixaInicial = n2(Number(caixa?.inicial ?? 0));
    const caixaFinal = n2(Number(caixa?.final ?? 0));
    const variacaoCaixa = n2(caixaFinal - caixaInicial);

    return {
      exercicio: data.exercicio,
      operacional,
      investimento,
      financiamento,
      geracao_liquida: geracaoLiquida,
      caixa_inicial: caixaInicial,
      caixa_final: caixaFinal,
      variacao_caixa: variacaoCaixa,
      // A DFC fecha quando a geração líquida explica a variação do caixa.
      conciliado: Math.abs(variacaoCaixa - geracaoLiquida) < 0.005,
    };
  });
