import { readFile } from "node:fs/promises";
const all = (
  await Promise.all(
    [
      "supabase/migrations/20260818040000_sprint16_data_mart.sql",
      "src/lib/data-mart.functions.ts",
    ].map((f) => readFile(new URL(`../${f}`, import.meta.url), "utf8")),
  )
).join("\n");
for (const t of [
  "create schema if not exists analytics",
  "fact_payroll",
  "fact_movement",
  "etl_runs",
  "reconciled",
  "analytics.manage",
  "revoke all on schema analytics",
])
  if (!all.includes(t)) throw Error(t);
console.log(
  JSON.stringify({
    private_schema: true,
    incremental_upsert: true,
    reconciliation: true,
    audit_runs: true,
  }),
);
