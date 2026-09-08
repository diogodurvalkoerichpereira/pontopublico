import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
export const getMyFinancialPortal = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const links = await query<any>(
      `select l.id,l.registration_number,l.tenant_id,p.full_name from public.employment_links l join public.persons p on p.id=l.person_id where l.source_profile_id=$1 order by l.registration_number`,
      [context.userId],
    );
    const ids = links.map((l: any) => l.id);
    if (!ids.length)
      return { links: [], payslips: [], vacations: [], margin: 0 };
    const payslips = await query<any>(
      `select pub.*,cycle.total_net from public.employee_financial_publications pub join public.payroll_cycles cycle on cycle.id=pub.payroll_cycle_id where pub.employment_link_id=any($1::uuid[])and pub.revoked_at is null order by pub.reference_month desc`,
      [ids],
    );
    const vacations = await query<any>(
      `select s.*,a.employment_link_id from public.vacation_schedules s join public.vacation_accrual_periods a on a.id=s.accrual_period_id where a.employment_link_id=any($1::uuid[]) order by s.start_date desc`,
      [ids],
    );
    const net =
      payslips.find((p: any) => p.document_type === "contracheque")?.payload
        ?.net_amount ?? 0;
    return { links, payslips, vacations, margin: Number(net) * 0.35 };
  });
const PublishInput = z.object({
  cycle_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
});

export const publishClosedPayroll = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => PublishInput.parse(v))
  .handler(async ({ data, context }) => {
    // Publicar contracheque é ato pós-fechamento do ciclo: exige ser membro do
    // ente e ter a permissão de fechar folha. Sem isto, qualquer usuário
    // autenticado publicava a folha de qualquer ente passando o tenant_id.
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.cycles.close");
    return withTransaction(async (c) => {
      const input = data;
      const cycle = (
        await c.query<any>(
          `select * from public.payroll_cycles where id=$1 and tenant_id=$2 and status='fechada'`,
          [input.cycle_id, input.tenant_id],
        )
      ).rows[0];
      if (!cycle) throw new Error("Folha fechada não encontrada");
      const rows = (
        await c.query<any>(
          `select * from public.payroll_cycle_results where cycle_id=$1`,
          [cycle.id],
        )
      ).rows;
      for (const r of rows) {
        const payload = {
          earnings: r.earnings,
          deductions: r.deductions,
          net_amount: r.net_amount,
          reference_month: cycle.reference_month,
        };
        const hash = createHash("sha256")
          .update(JSON.stringify(payload))
          .digest("hex");
        await c.query(
          `insert into public.employee_financial_publications(id,tenant_id,payroll_cycle_id,employment_link_id,document_type,reference_month,payload,document_sha256,verification_code)values($1,$2,$3,$4,'contracheque',$5,$6::jsonb,$7,$8)on conflict do nothing`,
          [
            randomUUID(),
            input.tenant_id,
            cycle.id,
            r.employment_link_id,
            cycle.reference_month,
            JSON.stringify(payload),
            hash,
            hash.slice(0, 12).toUpperCase(),
          ],
        );
      }
      return { published: rows.length, actor: context.userId };
    });
  });
