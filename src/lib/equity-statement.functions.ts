// O2-18 — Balanço patrimonial e Demonstração das Variações Patrimoniais (DVP)
// (Onda 2, PCASP / Lei 4.320 Anexo 14).
//
// Duas naturezas de saldo, e é isso que separa as duas consultas abaixo:
//   • PATRIMONIAIS (classes 1 e 2) são ACUMULADOS — o ativo e o passivo vêm de
//     todos os exercícios até o de referência. Apurá-los só pelo movimento do ano
//     zerava o balanço a cada 1º de janeiro (um bem incorporado em 2025 sumia do
//     balanço de 2026).
//   • DE RESULTADO (classes 3 e 4) são DO PERÍODO — VPD e VPA do exercício.
//
// No PCASP a classe 2 é "Passivo E Patrimônio Líquido": o grupo 2.3 é o PL. Somar
// a classe 2 inteira como passivo inflava o passivo publicado e fazia o "PL"
// devolvido ser sempre idêntico ao resultado do período (tautologia), porque com
// os livros equilibrados ativo − (passivo+PL) = 0.
//   Passivo            = −saldo(classe 2, exceto 2.3)
//   PL escriturado     = −saldo(grupo 2.3)  [acumulado de exercícios anteriores]
//   Patrimônio líquido = PL escriturado + resultado patrimonial do período
//   conferido          = ativo − (passivo + patrimônio líquido) ≈ 0
//
// Convenção de sinal: saldo = Σ(débito) − Σ(crédito); contas de natureza credora
// (Passivo, PL, VPA) têm o sinal invertido. Read-only, reusa accounting.read.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const Input = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
});

export const getEquityStatement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");

    // Saldos patrimoniais ACUMULADOS até o exercício (classes 1 e 2), com o
    // grupo 2.3 (patrimônio líquido) separado do passivo exigível.
    const patrimoniais = await query<{ grupo: string; saldo: string }>(
      `select
         case
           when left(l.conta, 1) = '1' then 'ativo'
           when left(l.conta, 3) = '2.3' then 'pl'
           else 'passivo'
         end as grupo,
         coalesce(sum(case when l.lado='D' then l.valor else -l.valor end),0)::text as saldo
       from public.accounting_entry_lines l
       join public.accounting_entries e on e.id = l.entry_id
       where l.tenant_id = $1 and e.exercicio <= $2
         and left(l.conta, 1) in ('1','2')
       group by 1`,
      [data.tenant_id, data.exercicio],
    );

    // Contas de resultado DO EXERCÍCIO (classes 3 e 4).
    const resultado = await query<{ classe: string; saldo: string }>(
      `select left(l.conta, 1) as classe,
         coalesce(sum(case when l.lado='D' then l.valor else -l.valor end),0)::text as saldo
       from public.accounting_entry_lines l
       join public.accounting_entries e on e.id = l.entry_id
       where l.tenant_id = $1 and e.exercicio = $2
         and left(l.conta, 1) in ('3','4')
       group by left(l.conta, 1)`,
      [data.tenant_id, data.exercicio],
    );

    const saldoGrupo = (grupo: string) =>
      Number(patrimoniais.find((g) => g.grupo === grupo)?.saldo ?? 0);
    const saldoClasse = (classe: string) =>
      Number(resultado.find((c) => c.classe === classe)?.saldo ?? 0);
    const n2 = (v: number) => Number(v.toFixed(2));

    // Ativo e VPD têm natureza devedora (saldo já positivo); Passivo, PL e VPA
    // têm natureza credora (invertemos o sinal para exibir o valor positivo).
    const ativo = n2(saldoGrupo("ativo"));
    const passivo = n2(-saldoGrupo("passivo"));
    const plEscriturado = n2(-saldoGrupo("pl"));
    const vpd = n2(saldoClasse("3"));
    const vpa = n2(-saldoClasse("4"));
    const resultadoPatrimonial = n2(vpa - vpd);
    // O PL do balanço é o acumulado escriturado mais o resultado ainda não
    // transposto para 2.3 (o encerramento do exercício é que faz essa transposição).
    const patrimonioLiquido = n2(plEscriturado + resultadoPatrimonial);

    return {
      exercicio: data.exercicio,
      ativo,
      passivo,
      patrimonio_liquido: patrimonioLiquido,
      // PL já escriturado em 2.3 (exercícios anteriores), à parte do resultado.
      patrimonio_liquido_escriturado: plEscriturado,
      vpa,
      vpd,
      // Resultado patrimonial do período (VPA − VPD): superávit se positivo.
      resultado_patrimonial: resultadoPatrimonial,
      // Equação patrimonial fecha: ativo = passivo + patrimônio líquido.
      conferido: Math.abs(ativo - (passivo + patrimonioLiquido)) < 0.005,
    };
  });
