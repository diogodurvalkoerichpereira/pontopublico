// O4-03 — Consulta de regularidade fiscal (Onda 4). Verifica se um contribuinte
// tem débitos em aberto (crédito lançado ou em dívida ativa com saldo devedor).
// É a BASE da certidão negativa de débitos (CND), NÃO a certidão em si: não emite
// documento oficial, código de autenticação nem assinatura — isso exige o layout
// e a validação do ente (fica pendente, ver CONFORMIDADE.md). Reusa taxes.read.
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
  contribuinte_documento: z.string().trim().min(3).max(20),
});

// Situação: "regular" (nada em aberto) ou "com_debitos". Débito em aberto é um
// crédito não quitado/cancelado com saldo > 0. Dívida ativa pesa como pendência.
export const checkTaxClearance = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const debts = await query<{
      id: string;
      tributo: string;
      exercicio: number;
      inscricao: string;
      saldo: string;
      status: string;
      vencimento: string;
    }>(
      `select id, tributo, exercicio, inscricao,
         (valor_lancado - valor_pago)::text as saldo, status, vencimento::text
       from public.tax_credits
       where tenant_id = $1
         and contribuinte_documento = $2
         and status in ('lancado', 'divida_ativa')
         and valor_lancado > valor_pago
       order by exercicio desc, tributo, inscricao`,
      [data.tenant_id, data.contribuinte_documento],
    );
    const saldoTotal = Number(
      debts.reduce((s, d) => s + Number(d.saldo), 0).toFixed(2),
    );
    const emDividaAtiva = debts.some((d) => d.status === "divida_ativa");
    return {
      contribuinte_documento: data.contribuinte_documento,
      situacao: debts.length === 0 ? "regular" : "com_debitos",
      saldo_total: saldoTotal,
      em_divida_ativa: emDividaAtiva,
      debts,
    };
  });
