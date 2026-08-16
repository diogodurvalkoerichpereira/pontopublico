import { readFile } from "node:fs/promises";
const all = (
  await Promise.all(
    [
      "supabase/migrations/20260818050000_sprint17_lrf_dashboard.sql",
      "src/lib/fiscal-dashboard.functions.ts",
      "src/routes/gestor/lrf.tsx",
    ].map((f) => readFile(new URL(`../${f}`, import.meta.url), "utf8")),
  )
).join("\n");
for (const t of [
  "legal_limit",
  "prudential_ratio",
  "warning_ratio",
  "limit 12",
  "net_current_revenue",
  "personnel_expense",
  "sourceUrl",
  "controle interno",
])
  if (!all.includes(t)) throw Error(t);
console.log(
  JSON.stringify({
    rolling_12_months: true,
    configurable_thresholds: true,
    official_basis: true,
    audit_warning: true,
  }),
);
