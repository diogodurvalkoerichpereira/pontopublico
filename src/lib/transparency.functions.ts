// O5-02 — Portal da transparência (Onda 5, LAI/Lei 12.527). Relatório consolidado
// de leitura sobre dados que já existem: execução da despesa, receita e contratos.
// Sem tabelas próprias; só agrega.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, queryOne } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const Input = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
});

const num = (v: unknown) => Number(v ?? 0);

export const getTransparencyReport = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "transparency.read");

    // Separar as agregações evita fan-out do join (o orçado seria multiplicado
    // pelo número de empenhos da dotação).
    const orcadoRow = await queryOne<{ orcado: string }>(
      `select coalesce(sum(valor_orcado),0)::text as orcado
       from public.budget_appropriations
       where tenant_id = $1 and exercicio = $2`,
      [data.tenant_id, data.exercicio],
    );
    const despesa = await queryOne<{
      empenhado: string;
      liquidado: string;
      pago: string;
    }>(
      `select
         coalesce(sum(c.valor) filter (where c.status <> 'anulado'),0)::text as empenhado,
         coalesce(sum(c.valor) filter (where c.status in ('liquidado','pago')),0)::text as liquidado,
         coalesce(sum(c.valor) filter (where c.status = 'pago'),0)::text as pago
       from public.budget_commitments c
       where c.tenant_id = $1 and c.exercicio = $2`,
      [data.tenant_id, data.exercicio],
    );

    const receita = await queryOne<{
      previsto: string;
      arrecadado: string;
    }>(
      `select coalesce(sum(valor_previsto),0)::text as previsto,
              coalesce(sum(valor_arrecadado),0)::text as arrecadado
       from public.budget_revenues where tenant_id = $1 and exercicio = $2`,
      [data.tenant_id, data.exercicio],
    );

    const contratos = await queryOne<{
      quantidade: string;
      valor_total: string;
    }>(
      `select count(*)::text as quantidade,
              coalesce(sum(valor_total),0)::text as valor_total
       from public.procurement_contracts
       where tenant_id = $1 and ano = $2 and status <> 'rescindido'`,
      [data.tenant_id, data.exercicio],
    );

    const orcado = num(orcadoRow?.orcado);
    const empenhado = num(despesa?.empenhado);
    const previsto = num(receita?.previsto);
    const arrecadado = num(receita?.arrecadado);
    return {
      exercicio: data.exercicio,
      despesa: {
        orcado,
        empenhado,
        liquidado: num(despesa?.liquidado),
        pago: num(despesa?.pago),
        saldo: Number((orcado - empenhado).toFixed(2)),
      },
      receita: {
        previsto,
        arrecadado,
        a_realizar: Number((previsto - arrecadado).toFixed(2)),
      },
      contratos: {
        quantidade: num(contratos?.quantidade),
        valor_total: num(contratos?.valor_total),
      },
      // Resultado orçamentário simplificado (arrecadado − pago).
      resultado_orcamentario: Number(
        (arrecadado - num(despesa?.pago)).toFixed(2),
      ),
    };
  });

// O5-02b — Despesa por função de governo (transparência ativa, LAI/LC 131). Agrega
// a execução da despesa (empenhado não anulado, liquidado, pago) pela FUNÇÃO da
// classificação da dotação (saúde, educação, …) — a leitura que o cidadão procura
// ("quanto foi para cada área?"). Empenho anulado não conta; função sem empenho não
// aparece; ordena pelo maior empenhado. Read-only, reusa transparency.read.
export const getTransparencyByFunction = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "transparency.read");
    const rows = await query<{
      funcao: string;
      empenhado: string;
      liquidado: string;
      pago: string;
    }>(
      `select a.funcao,
         coalesce(sum(c.valor) filter (where c.status <> 'anulado'),0)::text as empenhado,
         coalesce(sum(c.valor) filter (where c.status in ('liquidado','pago')),0)::text as liquidado,
         coalesce(sum(c.valor) filter (where c.status = 'pago'),0)::text as pago
       from public.budget_commitments c
       join public.budget_appropriations a on a.id = c.appropriation_id
       where c.tenant_id = $1 and c.exercicio = $2
       group by a.funcao
       having coalesce(sum(c.valor) filter (where c.status <> 'anulado'),0) > 0
       order by empenhado desc, a.funcao`,
      [data.tenant_id, data.exercicio],
    );
    const funcoes = rows.map((r) => ({
      funcao: r.funcao,
      empenhado: num(r.empenhado),
      liquidado: num(r.liquidado),
      pago: num(r.pago),
    }));
    const totais = funcoes.reduce(
      (acc, f) => ({
        empenhado: Number((acc.empenhado + f.empenhado).toFixed(2)),
        liquidado: Number((acc.liquidado + f.liquidado).toFixed(2)),
        pago: Number((acc.pago + f.pago).toFixed(2)),
      }),
      { empenhado: 0, liquidado: 0, pago: 0 },
    );
    return { exercicio: data.exercicio, funcoes, totais };
  });

// O5-02c — Dados abertos do Portal da Transparência (LC 131/2009 §3º: formato
// aberto, processável por máquina). Empacota num único payload autodescritivo
// (metadados de proveniência + licença) a execução da despesa por função e por
// credor e a receita do exercício, já existentes (O5-02/O5-02b) — para download
// e reuso por terceiros (imprensa, pesquisa, TCE) sem depender de tela. Credor
// sem saldo empenhado não aparece, mesma regra do por-função. Read-only, reusa
// transparency.read; sem tabela própria.
export const getOpenDataTransparencia = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "transparency.read");

    const tenant = await queryOne<{
      codigo: string;
      nome: string;
      cnpj: string | null;
    }>(`select codigo, nome, cnpj from public.tenants where id = $1`, [
      data.tenant_id,
    ]);

    const porFuncao = await query<{
      funcao: string;
      empenhado: string;
      liquidado: string;
      pago: string;
    }>(
      `select a.funcao,
         coalesce(sum(c.valor) filter (where c.status <> 'anulado'),0)::text as empenhado,
         coalesce(sum(c.valor) filter (where c.status in ('liquidado','pago')),0)::text as liquidado,
         coalesce(sum(c.valor) filter (where c.status = 'pago'),0)::text as pago
       from public.budget_commitments c
       join public.budget_appropriations a on a.id = c.appropriation_id
       where c.tenant_id = $1 and c.exercicio = $2
       group by a.funcao
       having coalesce(sum(c.valor) filter (where c.status <> 'anulado'),0) > 0
       order by empenhado desc, a.funcao`,
      [data.tenant_id, data.exercicio],
    );

    const porCredor = await query<{
      credor: string;
      qtd: string;
      empenhado: string;
      liquidado: string;
      pago: string;
    }>(
      `select c.credor,
         count(*) filter (where c.status <> 'anulado')::text as qtd,
         coalesce(sum(c.valor) filter (where c.status <> 'anulado'),0)::text as empenhado,
         coalesce(sum(c.valor) filter (where c.status in ('liquidado','pago')),0)::text as liquidado,
         coalesce(sum(c.valor) filter (where c.status = 'pago'),0)::text as pago
       from public.budget_commitments c
       where c.tenant_id = $1 and c.exercicio = $2
       group by c.credor
       having coalesce(sum(c.valor) filter (where c.status <> 'anulado'),0) > 0
       order by empenhado desc, c.credor`,
      [data.tenant_id, data.exercicio],
    );

    const receita = await queryOne<{ previsto: string; arrecadado: string }>(
      `select coalesce(sum(valor_previsto),0)::text as previsto,
              coalesce(sum(valor_arrecadado),0)::text as arrecadado
       from public.budget_revenues where tenant_id = $1 and exercicio = $2`,
      [data.tenant_id, data.exercicio],
    );

    return {
      formato: "dados-abertos-transparencia",
      versao: "1.0",
      licenca: "ODbL 1.0 — uso e redistribuição livres, com atribuição",
      ente: tenant
        ? { codigo: tenant.codigo, nome: tenant.nome, cnpj: tenant.cnpj }
        : null,
      exercicio: data.exercicio,
      gerado_em: new Date().toISOString(),
      despesa_por_funcao: porFuncao.map((r) => ({
        funcao: r.funcao,
        empenhado: num(r.empenhado),
        liquidado: num(r.liquidado),
        pago: num(r.pago),
      })),
      despesa_por_credor: porCredor.map((r) => ({
        credor: r.credor,
        quantidade_empenhos: num(r.qtd),
        empenhado: num(r.empenhado),
        liquidado: num(r.liquidado),
        pago: num(r.pago),
      })),
      receita: {
        previsto: num(receita?.previsto),
        arrecadado: num(receita?.arrecadado),
      },
    };
  });
