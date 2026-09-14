import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
const tenant = z.object({ tenant_id: z.string().uuid() });

export const refreshDataMart = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => parseInput(tenant, v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "analytics.manage");
    const run = (
      await query<{ id: string }>(
        `insert into analytics.etl_runs(tenant_id,status,created_by) values($1,'running',$2) returning id`,
        [data.tenant_id, context.userId],
      )
    )[0];
    await query(
      `insert into analytics.fact_payroll(tenant_id,cycle_id,reference_month,cycle_type,links_count,total_earnings,total_deductions,total_net,source_updated_at)
    select tenant_id,id,reference_month,cycle_type,links_count,total_earnings,total_deductions,total_net,updated_at from public.payroll_cycles where tenant_id=$1 and status='fechada'
    on conflict(tenant_id,cycle_id) do update set links_count=excluded.links_count,total_earnings=excluded.total_earnings,total_deductions=excluded.total_deductions,total_net=excluded.total_net,source_updated_at=excluded.source_updated_at,loaded_at=now()`,
      [data.tenant_id],
    );
    await query(
      `insert into analytics.fact_payroll_item(tenant_id,cycle_id,item_id,link_id,rubric_id,unit_id,earnings,deductions,net)
     select i.tenant_id,c.id,i.id,i.employment_link_id,i.rubric_id,l.unit_id,
       case when r.nature='provento' then i.amount else 0 end,
       case when r.nature='desconto' then i.amount else 0 end,
       case when r.nature='provento' then i.amount when r.nature='desconto' then -i.amount else 0 end
     from public.payroll_cycles c join public.payroll_calculation_items i on i.run_id=c.source_run_id
     join public.payroll_rubrics r on r.id=i.rubric_id join public.employment_links l on l.id=i.employment_link_id
     where c.tenant_id=$1 and c.status='fechada'
     on conflict(tenant_id,item_id) do update set earnings=excluded.earnings,deductions=excluded.deductions,net=excluded.net,unit_id=excluded.unit_id,loaded_at=now()`,
      [data.tenant_id],
    );
    await query(
      `insert into analytics.fact_movement(tenant_id,movement_id,link_id,unit_id,movement_type,effective_date)
     select tenant_id,id,employment_link_id,coalesce(to_unit_id,from_unit_id),movement_type,effective_date
     from public.employment_link_movements where tenant_id=$1
     on conflict(tenant_id,movement_id) do update set unit_id=excluded.unit_id,movement_type=excluded.movement_type,effective_date=excluded.effective_date,loaded_at=now()`,
      [data.tenant_id],
    );
    const stats = (
      await query<any>(
        `select (select count(*) from public.payroll_cycles where tenant_id=$1 and status='fechada') source_rows,count(*) mart_rows,
    (select coalesce(sum(total_net),0) from public.payroll_cycles where tenant_id=$1 and status='fechada') source_total,coalesce(sum(total_net),0) mart_total
    from analytics.fact_payroll where tenant_id=$1`,
        [data.tenant_id],
      )
    )[0];
    await query(
      `update analytics.etl_runs set status='completed',finished_at=now(),source_rows=$2,mart_rows=$3,source_total=$4,mart_total=$5,checksum=md5($4::text||':'||$5::text) where id=$1`,
      [
        run.id,
        stats.source_rows,
        stats.mart_rows,
        stats.source_total,
        stats.mart_total,
      ],
    );
    return {
      ...stats,
      reconciled:
        Number(stats.source_rows) === Number(stats.mart_rows) &&
        Number(stats.source_total) === Number(stats.mart_total),
    };
  });

export const getDataMartStatus = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => parseInput(tenant, v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "analytics.read");
    const rows = await query<any>(
      `select *,(source_rows=mart_rows and source_total=mart_total) reconciled from analytics.etl_runs where tenant_id=$1 order by started_at desc limit 20`,
      [data.tenant_id],
    );
    return { runs: rows, latest: rows[0] ?? null };
  });
