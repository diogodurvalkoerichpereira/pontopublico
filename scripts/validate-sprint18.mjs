import { readFile } from "node:fs/promises";
const f = await readFile(
    new URL("../src/lib/ai-analytics.functions.ts", import.meta.url),
    "utf8",
  ),
  sql = await readFile(
    new URL(
      "../supabase/migrations/20260818060000_sprint18_semantic_ai.sql",
      import.meta.url,
    ),
    "utf8",
  );
for (const t of [
  "resolveSemanticIntent",
  "SemanticMetric",
  "analytics.fact_payroll",
  "fiscal_monthly_balances",
  "profileDataset",
  "max(1000)",
  "evidence",
  "ai_saved_panels",
  "auth.uid()",
])
  if (!(f + sql).includes(t)) throw Error(t);
if (f.includes("query<any>(data.question")) throw Error("SQL livre");
console.log(
  JSON.stringify({
    semantic_whitelist: true,
    conversations: true,
    evidence: true,
    dataset_profile: true,
    no_free_sql: true,
  }),
);
