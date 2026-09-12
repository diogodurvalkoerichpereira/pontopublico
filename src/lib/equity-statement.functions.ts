// O2-18 — Balanço patrimonial e Demonstração das Variações Patrimoniais (DVP)
// (Onda 2, PCASP / Lei 4.320 Anexo 14). Classifica o razão (accounting_entry_lines)
// pela primeira classe da conta PCASP e apura, no exercício:
//   Ativo (classe 1), Passivo (classe 2), Patrimônio Líquido = Ativo − Passivo;
//   VPA (classe 4, variação aumentativa), VPD (classe 3, diminutiva) e o
//   resultado patrimonial = VPA − VPD.
// Convenção de sinal: saldo = Σ(débito) − Σ(crédito); contas de natureza credora
// (Passivo, VPA) têm o sinal invertido. Read-only, reusa accounting.read, sem migration.
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

    // Saldo líquido por classe PCASP (primeiro dígito da conta).
    const classes = await query<{ classe: string; saldo: string }>(
      `select left(l.conta, 1) as classe,
         coalesce(sum(case when l.lado='D' then l.valor else -l.valor end),0)::text as saldo
       from public.accounting_entry_lines l
       join public.accounting_entries e on e.id = l.entry_id
       where l.tenant_id = $1 and e.exercicio = $2
       group by left(l.conta, 1)`,
      [data.tenant_id, data.exercicio],
    );

    const saldoDe = (classe: string) =>
      Number(classes.find((c) => c.classe === classe)?.saldo ?? 0);
    const n2 = (v: number) => Number(v.toFixed(2));

    // Ativo e VPD têm natureza devedora (saldo já positivo); Passivo e VPA têm
    // natureza credora (invertemos o sinal para exibir o valor positivo).
    const ativo = n2(saldoDe("1"));
    const passivo = n2(-saldoDe("2"));
    const vpd = n2(saldoDe("3"));
    const vpa = n2(-saldoDe("4"));

    return {
      exercicio: data.exercicio,
      ativo,
      passivo,
      // Patrimônio líquido apurado no balanço (Ativo − Passivo).
      patrimonio_liquido: n2(ativo - passivo),
      vpa,
      vpd,
      // Resultado patrimonial do período (VPA − VPD): superávit se positivo.
      resultado_patrimonial: n2(vpa - vpd),
    };
  });
