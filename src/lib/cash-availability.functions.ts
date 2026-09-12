// O2-12 — Demonstrativo de disponibilidade de caixa (Onda 2, base do balanço
// financeiro, Lei 4.320). Consolida o saldo das contas de tesouraria e o fluxo do
// período: ingressos e saídas (operacionais) e as transferências internas
// (que se anulam entre contas do ente). Read-only, reusa accounting.read.
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
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

export const getCashAvailability = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");

    // Saldo consolidado: soma dos saldos das contas ativas.
    const contas = await query<{
      id: string;
      nome: string;
      tipo: string;
      saldo_atual: string;
    }>(
      `select id, nome, tipo, saldo_atual::text
       from public.treasury_accounts
       where tenant_id = $1 and status = 'ativa'
       order by nome`,
      [data.tenant_id],
    );
    const saldoConsolidado = Number(
      contas.reduce((s, c) => s + Number(c.saldo_atual), 0).toFixed(2),
    );

    // Fluxo do período por tipo de movimento (transferências internas à parte).
    const fluxo = await queryOne<{
      ingressos: string;
      saidas: string;
      transf_entrada: string;
      transf_saida: string;
    }>(
      `select
         coalesce(sum(valor) filter (where tipo='ingresso'),0)::text as ingressos,
         coalesce(sum(valor) filter (where tipo='saida'),0)::text as saidas,
         coalesce(sum(valor) filter (where tipo='transferencia_entrada'),0)::text as transf_entrada,
         coalesce(sum(valor) filter (where tipo='transferencia_saida'),0)::text as transf_saida
       from public.treasury_movements
       where tenant_id = $1
         and ($2::date is null or data_movimento >= $2)
         and ($3::date is null or data_movimento <= $3)`,
      [data.tenant_id, data.from ?? null, data.to ?? null],
    );
    const ingressos = Number(fluxo?.ingressos ?? 0);
    const saidas = Number(fluxo?.saidas ?? 0);

    return {
      saldo_consolidado: saldoConsolidado,
      ingressos,
      saidas,
      // Fluxo líquido operacional do período (ingressos − saídas).
      fluxo_liquido: Number((ingressos - saidas).toFixed(2)),
      transferencias_entrada: Number(fluxo?.transf_entrada ?? 0),
      transferencias_saida: Number(fluxo?.transf_saida ?? 0),
      contas,
    };
  });
