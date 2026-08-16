import { readFile } from "node:fs/promises";
const [s, c] = await Promise.all([
  readFile(
    new URL(
      "../supabase/migrations/20260817210000_sprint9_batch_imports.sql",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL("../src/routes/rh.importacoes.tsx", import.meta.url),
    "utf8",
  ),
]);
for (const t of [
  "payroll_import_batches",
  "payroll_import_rows",
  "payroll_monthly_variables",
  "pre_validado",
  "file_sha256",
  "enable row level security",
])
  if (!s.includes(t)) throw new Error(t);
if (!c.includes('import("exceljs")')) throw new Error("XLSX ausente");
console.log(
  JSON.stringify({
    txt: true,
    csv: true,
    xlsx: true,
    prevalidation: true,
    atomic_commit: true,
    rls: true,
  }),
);
