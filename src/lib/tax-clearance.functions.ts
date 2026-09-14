// O4-03 — Consulta de regularidade fiscal (Onda 4). Verifica se um contribuinte
// tem débitos em aberto (crédito lançado ou em dívida ativa com saldo devedor).
// Um débito com parcelamento ATIVO tem a exigibilidade suspensa (CTN art. 151, VI):
// se todos os débitos em aberto estão suspensos, o contribuinte é regular COM RESSALVA
// (base da certidão positiva com efeito de negativa — CPEN, CTN art. 206).
// É a BASE da certidão negativa de débitos (CND), NÃO a certidão em si: não emite
// documento oficial, código de autenticação nem assinatura — isso exige o layout
// e a validação do ente (fica pendente, ver CONFORMIDADE.md). Reusa taxes.read.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const Input = z.object({
  tenant_id: z.string().uuid(),
  contribuinte_documento: z.string().trim().min(3).max(20),
});

// Situação: "regular" (nada em aberto), "regular_com_ressalva" (há débitos, mas NENHUM
// exigível hoje — suspensos por parcelamento ativo ou ainda a vencer → CPEN) ou
// "com_debitos" (ao menos um débito exigível). Débito em aberto é um crédito não
// quitado/cancelado com saldo > 0.
//
// Duas regras que o caminho anterior errava:
// 1. O documento é comparado **normalizado** (só letras e dígitos). O mesmo CPF entra no
//    cadastro ora com máscara, ora sem — comparar a string crua devolvia "regular" para
//    quem devia, que é o pior erro possível numa certidão.
// 2. Crédito **a vencer** não é impedimento (CTN art. 205: a certidão atesta débito
//    exigível). Ele entra em `debts` marcado `vencido:false` e conta em `saldo_a_vencer`,
//    mas não rebaixa a situação — antes, lançar o IPTU do exercício bloqueava a CND de
//    todos os contribuintes do município até o vencimento.
export const checkTaxClearance = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(Input, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const rows = await query<{
      id: string;
      tributo: string;
      exercicio: number;
      inscricao: string;
      saldo: string;
      status: string;
      vencimento: string;
      suspenso: boolean;
      vencido: boolean;
    }>(
      `select tc.id, tc.tributo, tc.exercicio, tc.inscricao,
         (tc.valor_lancado - tc.valor_pago)::text as saldo, tc.status,
         tc.vencimento::text,
         exists (
           select 1 from public.tax_installment_plans p
           where p.credit_id = tc.id and p.tenant_id = tc.tenant_id
             and p.status = 'ativo'
         ) as suspenso,
         (tc.vencimento < current_date) as vencido
       from public.tax_credits tc
       where tc.tenant_id = $1
         and regexp_replace(lower(tc.contribuinte_documento), '[^0-9a-z]', '', 'g')
             = regexp_replace(lower($2), '[^0-9a-z]', '', 'g')
         and tc.status in ('lancado', 'divida_ativa')
         and tc.valor_lancado > tc.valor_pago
       order by tc.exercicio desc, tc.tributo, tc.inscricao`,
      [data.tenant_id, data.contribuinte_documento],
    );
    const debts = rows.map((d) => ({
      ...d,
      suspenso: Boolean(d.suspenso),
      vencido: Boolean(d.vencido),
    }));
    const round2 = (v: number) => Number(v.toFixed(2));
    const soma = (list: typeof debts) =>
      round2(list.reduce((s, d) => s + Number(d.saldo), 0));
    const saldoTotal = soma(debts);
    const saldoSuspenso = soma(debts.filter((d) => d.suspenso));
    const aVencer = debts.filter((d) => !d.suspenso && !d.vencido);
    // Exigível hoje: vencido e sem parcelamento ativo. Dívida ativa entra por já ter
    // vencido na origem; o parcelamento suspende a exigibilidade também dela.
    const exigiveis = debts.filter((d) => !d.suspenso && d.vencido);
    const emDividaAtiva = debts.some((d) => d.status === "divida_ativa");
    const situacao =
      debts.length === 0
        ? "regular"
        : exigiveis.length === 0
          ? "regular_com_ressalva"
          : "com_debitos";
    return {
      contribuinte_documento: data.contribuinte_documento,
      situacao,
      saldo_total: saldoTotal,
      saldo_suspenso: saldoSuspenso,
      saldo_a_vencer: soma(aVencer),
      saldo_exigivel: soma(exigiveis),
      em_divida_ativa: emDividaAtiva,
      debts,
    };
  });
