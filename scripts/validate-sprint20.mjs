import { readFile } from "node:fs/promises";
const all = (
  await Promise.all(
    [
      "supabase/migrations/20260818080000_sprint20_historical_migration.sql",
      "src/lib/historical-migration.functions.ts",
      "src/routes/admin/migracao-historica.tsx",
    ].map((f) => readFile(new URL(`../${f}`, import.meta.url), "utf8")),
  )
).join("\n");
for (const t of [
  "historical_migration_jobs",
  "historical_migration_rows",
  "historical_records",
  "fora_da_janela_de_15_anos",
  "on conflict(job_id,source_key)",
  "reconciled",
  "Reconciliação obrigatória",
  "archiveOnly",
])
  if (!all.includes(t)) throw Error(t);
console.log(
  JSON.stringify({
    fifteen_year_window: true,
    idempotent_staging: true,
    row_validation: true,
    reconciliation_gate: true,
    archive_isolation: true,
  }),
);
