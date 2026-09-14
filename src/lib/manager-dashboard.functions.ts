import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
export const getManagerDashboard = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    parseInput(z.object({ tenant_id: z.string().uuid() }), v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "manager.dashboard.read");
    const [series, headcount, units, movements] = await Promise.all([
      query<any>(
        `select reference_month::text,sum(total_earnings)::numeric bruto,sum(total_deductions)::numeric descontos,sum(total_net)::numeric liquido,sum(links_count)::int vinculos from public.payroll_cycles where tenant_id=$1 and cycle_type='mensal' and status='fechada' group by reference_month order by reference_month`,
        [data.tenant_id],
      ),
      query<any>(
        `select count(*)filter(where status='ativo')::int ativos,count(*)filter(where status='afastado')::int afastados,count(*)filter(where status='desligado')::int desligados,avg(extract(year from age(current_date,p.birth_date)))::numeric idade_media from public.employment_links l join public.persons p on p.id=l.person_id where l.tenant_id=$1`,
        [data.tenant_id],
      ),
      query<any>(
        `select coalesce(u.nome,'Sem unidade') unidade,count(*)::int servidores,sum(l.base_salary)::numeric massa_base from public.employment_links l left join public.unidades u on u.id=l.unit_id where l.tenant_id=$1 and l.status='ativo' group by u.nome order by servidores desc`,
        [data.tenant_id],
      ),
      query<any>(
        `select date_trunc('month',effective_date)::date::text mes,count(*)filter(where movement_type='admissao')::int admitidos,count(*)filter(where movement_type='desligamento')::int desligados from public.employment_link_movements where tenant_id=$1 group by 1 order by 1`,
        [data.tenant_id],
      ),
    ]);
    return {
      series,
      headcount: headcount[0] ?? {},
      units,
      movements,
      reconciled: series.every(
        (x: any) => Number(x.bruto) - Number(x.descontos) === Number(x.liquido),
      ),
    };
  });
