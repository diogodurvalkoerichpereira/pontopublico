// O2-05b — Leituras da contabilidade (razão contábil PCASP). Separadas de
// `accounting.functions.ts` porque aquele módulo expõe o helper `postEntry`, que importa
// `audit.server` (barreira servidor); mantê-las aqui deixa o cliente consumir os relatórios
// (balancete, razão) sem arrastar a escrita/auditoria para o bundle. Só leitura,
// accounting.read.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200).optional(),
});

export const getAccountingEntries = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");
    const entries = await query<{
      id: string;
      exercicio: number;
      data_lancamento: string;
      historico: string;
      source: string;
      valor: string;
    }>(
      `select id, exercicio, data_lancamento::text, historico, source, valor::text
       from public.accounting_entries
       where tenant_id = $1 and ($2::int is null or exercicio = $2)
       order by data_lancamento desc, created_at desc
       limit 500`,
      [data.tenant_id, data.exercicio ?? null],
    );
    return { entries };
  });

const BalanceteInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
});

// Balancete: saldo por conta (Σdébito - Σcrédito) no exercício.
// O2-05c — Balancete de VERIFICAÇÃO (PCASP, Lei 4.320): além do saldo por conta, devolve os
// totais de débito e crédito e o flag `conferido` (Σdébitos = Σcréditos). A dupla partida é
// garantida no lançamento (postAccountingEntry recusa desbalanceado), então `conferido` é a
// prova de fechamento do período — que a lista crua de contas não afirmava. Read-only.
export const getBalancete = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => BalanceteInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");
    const contas = await query<{
      conta: string;
      debito: string;
      credito: string;
      saldo: string;
    }>(
      `select l.conta,
         coalesce(sum(case when l.lado='D' then l.valor else 0 end),0)::text as debito,
         coalesce(sum(case when l.lado='C' then l.valor else 0 end),0)::text as credito,
         coalesce(sum(case when l.lado='D' then l.valor else -l.valor end),0)::text as saldo
       from public.accounting_entry_lines l
       join public.accounting_entries e on e.id = l.entry_id
       where l.tenant_id = $1 and e.exercicio = $2
       group by l.conta
       order by l.conta`,
      [data.tenant_id, data.exercicio],
    );
    const round2 = (v: number) => Number(v.toFixed(2));
    const debito = round2(contas.reduce((s, c) => s + Number(c.debito), 0));
    const credito = round2(contas.reduce((s, c) => s + Number(c.credito), 0));
    return {
      contas,
      totais: { debito, credito, saldo: round2(debito - credito) },
      // Balancete "bate" quando o total de débitos iguala o de créditos.
      conferido: debito === credito,
    };
  });

const LedgerInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
  conta: z.string().trim().min(1).max(60),
});

// O2-05b — Razão de uma conta contábil (livro razão, PCASP). Lista, em ordem cronológica,
// os lançamentos que tocaram a conta no exercício (data, histórico, lado D/C, valor) com o
// **saldo corrente** após cada um (Σdébito − Σcrédito), além dos totais. É o detalhe que o
// balancete consolida — para auditoria e conciliação. Read-only, reusa accounting.read.
export const getAccountLedger = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => LedgerInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");
    const rows = await query<{
      id: string;
      data_lancamento: string;
      historico: string;
      lado: string;
      valor: string;
    }>(
      `select l.id, e.data_lancamento::text, e.historico, l.lado, l.valor::text
       from public.accounting_entry_lines l
       join public.accounting_entries e on e.id = l.entry_id
       where l.tenant_id = $1 and e.exercicio = $2 and l.conta = $3
       order by e.data_lancamento, e.created_at, l.id`,
      [data.tenant_id, data.exercicio, data.conta],
    );
    let saldo = 0;
    let debito = 0;
    let credito = 0;
    const linhas = rows.map((r) => {
      const valor = Number(r.valor);
      if (r.lado === "D") {
        saldo += valor;
        debito += valor;
      } else {
        saldo -= valor;
        credito += valor;
      }
      return {
        id: r.id,
        data_lancamento: r.data_lancamento,
        historico: r.historico,
        lado: r.lado,
        valor,
        saldo: Number(saldo.toFixed(2)),
      };
    });
    return {
      conta: data.conta,
      linhas,
      debito: Number(debito.toFixed(2)),
      credito: Number(credito.toFixed(2)),
      saldo: Number((debito - credito).toFixed(2)),
    };
  });
