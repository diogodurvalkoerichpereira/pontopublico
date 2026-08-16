import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
const tenant = z.object({ tenant_id: z.string().uuid() });
export const saveFiscalMonth = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        reference_month: z.string().regex(/^\d{4}-\d{2}-01$/),
        net_current_revenue: z.number().nonnegative(),
        personnel_expense: z.number().nonnegative(),
        source_document: z.string().max(300).optional(),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "fiscal.manage");
    await query(
      `insert into public.fiscal_monthly_balances(tenant_id,reference_month,net_current_revenue,personnel_expense,source_document,updated_by) values($1,$2,$3,$4,$5,$6) on conflict(tenant_id,reference_month) do update set net_current_revenue=excluded.net_current_revenue,personnel_expense=excluded.personnel_expense,source_document=excluded.source_document,updated_by=excluded.updated_by,updated_at=now()`,
      [
        data.tenant_id,
        data.reference_month,
        data.net_current_revenue,
        data.personnel_expense,
        data.source_document ?? null,
        context.userId,
      ],
    );
    return { saved: true };
  });
export const getFiscalDashboard = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => tenant.parse(v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "fiscal.read");
    const [rows, configs] = await Promise.all([
      query<any>(
        `select * from public.fiscal_monthly_balances where tenant_id=$1 order by reference_month desc limit 12`,
        [data.tenant_id],
      ),
      query<any>(
        `select * from public.fiscal_limit_configs where tenant_id=$1`,
        [data.tenant_id],
      ),
    ]);
    const config = configs[0] ?? {
      legal_limit: 0.54,
      prudential_ratio: 0.95,
      warning_ratio: 0.9,
      legal_basis: "LC 101/2000, arts. 20, 22 e 59",
      source_url: "https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp101.htm",
    };
    const rcl = rows.reduce((s, r) => s + Number(r.net_current_revenue), 0),
      personnel = rows.reduce((s, r) => s + Number(r.personnel_expense), 0),
      ratio = rcl ? personnel / rcl : 0,
      warning = Number(config.legal_limit) * Number(config.warning_ratio),
      prudential = Number(config.legal_limit) * Number(config.prudential_ratio);
    const level =
      ratio > Number(config.legal_limit)
        ? "exceeded"
        : ratio > prudential
          ? "prudential"
          : ratio > warning
            ? "warning"
            : "regular";
    return {
      months: rows,
      rcl,
      personnel,
      ratio,
      warning,
      prudential,
      legalLimit: Number(config.legal_limit),
      level,
      legalBasis: config.legal_basis,
      sourceUrl: config.source_url,
      windowMonths: rows.length,
    };
  });
