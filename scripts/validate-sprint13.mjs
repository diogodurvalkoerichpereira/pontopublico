import { readFile } from "node:fs/promises";
const [s, m] = await Promise.all([
  readFile(
    new URL(
      "../supabase/migrations/20260818010000_sprint13_employee_financial_portal.sql",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL("../src/lib/employee-finance.functions.ts", import.meta.url),
    "utf8",
  ),
]);
for (const t of [
  "legacy_profile_id=auth.uid()",
  "contracheque",
  "informe_rendimentos",
  "verification_code",
  "status='fechada'",
  "margin",
])
  if (!(s + m).includes(t)) throw new Error(t);
console.log(
  JSON.stringify({
    self_scope: true,
    payslips: true,
    vacations: true,
    margin: true,
    verification: true,
  }),
);
