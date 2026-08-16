import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
export type SemanticMetric =
  "net_payroll" | "gross_payroll" | "headcount" | "deductions" | "lrf_ratio";
export function resolveSemanticIntent(question: string): SemanticMetric | null {
  const q = question
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/lrf|rcl|limite fiscal/.test(q)) return "lrf_ratio";
  if (/servidor|vinculo|headcount|quantos/.test(q)) return "headcount";
  if (/desconto/.test(q)) return "deductions";
  if (/brut/.test(q)) return "gross_payroll";
  if (/liquid|folha|pagamento/.test(q)) return "net_payroll";
  return null;
}
const queries: Record<Exclude<SemanticMetric, "lrf_ratio">, string> = {
  net_payroll:
    "select reference_month,total_net value from analytics.fact_payroll where tenant_id=$1 order by reference_month desc limit 12",
  gross_payroll:
    "select reference_month,total_earnings value from analytics.fact_payroll where tenant_id=$1 order by reference_month desc limit 12",
  deductions:
    "select reference_month,total_deductions value from analytics.fact_payroll where tenant_id=$1 order by reference_month desc limit 12",
  headcount:
    "select reference_month,links_count value from analytics.fact_payroll where tenant_id=$1 order by reference_month desc limit 12",
};
export const askAnalytics = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        question: z.string().min(3).max(500),
        conversation_id: z.string().uuid().optional(),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "ai.analytics.use");
    const metric = resolveSemanticIntent(data.question);
    if (!metric)
      return {
        metric: null,
        answer:
          "Não reconheci uma métrica segura. Tente: folha líquida, folha bruta, descontos, servidores ou LRF.",
        series: [],
        evidence: { source: "semantic_catalog", rows: 0 },
      };
    let series: any[] = [];
    if (metric === "lrf_ratio")
      series = await query<any>(
        `select reference_month,case when net_current_revenue=0 then 0 else personnel_expense/net_current_revenue end value from public.fiscal_monthly_balances where tenant_id=$1 order by reference_month desc limit 12`,
        [data.tenant_id],
      );
    else series = await query<any>(queries[metric], [data.tenant_id]);
    const latest = Number(series[0]?.value ?? 0),
      labels = {
        net_payroll: "folha líquida",
        gross_payroll: "folha bruta",
        deductions: "descontos",
        headcount: "vínculos",
        lrf_ratio: "relação pessoal/RCL",
      };
    const answer = series.length
      ? `A métrica ${labels[metric]} mais recente é ${metric === "lrf_ratio" ? (latest * 100).toFixed(2) + "%" : latest.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}. A resposta usa ${series.length} competência(s) reconciliada(s).`
      : `Ainda não há dados reconciliados para ${labels[metric]}.`;
    const cid =
      data.conversation_id ??
      (
        await query<{ id: string }>(
          `insert into public.ai_conversations(tenant_id,user_id,title) values($1,$2,$3) returning id`,
          [data.tenant_id, context.userId, data.question.slice(0, 80)],
        )
      )[0].id;
    await query(
      `insert into public.ai_messages(conversation_id,role,content,metric_code,evidence) values($1,'user',$2,$3,'{}'),($1,'assistant',$4,$3,$5)`,
      [
        cid,
        data.question,
        metric,
        answer,
        JSON.stringify({
          source:
            metric === "lrf_ratio"
              ? "fiscal_monthly_balances"
              : "analytics.fact_payroll",
          rows: series.length,
        }),
      ],
    );
    return {
      conversationId: cid,
      metric,
      answer,
      series,
      evidence: {
        source:
          metric === "lrf_ratio"
            ? "fiscal_monthly_balances"
            : "analytics.fact_payroll",
        rows: series.length,
      },
    };
  });
export const profileDataset = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        name: z.string().max(120),
        rows: z
          .array(
            z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
          )
          .max(1000),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "ai.analytics.use");
    const cols = [...new Set(data.rows.flatMap(Object.keys))];
    return {
      name: data.name,
      rowCount: data.rows.length,
      columns: cols.map((name) => {
        const vals = data.rows
          .map((r) => r[name])
          .filter((v) => v !== null && v !== "");
        const nums = vals.map(Number).filter(Number.isFinite);
        return {
          name,
          filled: vals.length,
          numeric: nums.length === vals.length && vals.length > 0,
          min: nums.length ? Math.min(...nums) : null,
          max: nums.length ? Math.max(...nums) : null,
          total: nums.length ? nums.reduce((s, n) => s + n, 0) : null,
        };
      }),
    };
  });

export const saveSemanticPanel = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        title: z.string().min(3).max(120),
        metric_code: z.enum([
          "net_payroll",
          "gross_payroll",
          "headcount",
          "deductions",
          "lrf_ratio",
        ]),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "ai.analytics.use");
    const panel = (
      await query<{ id: string }>(
        `insert into public.ai_saved_panels(tenant_id,user_id,title,metric_code) values($1,$2,$3,$4) returning id`,
        [data.tenant_id, context.userId, data.title, data.metric_code],
      )
    )[0];
    return panel;
  });
