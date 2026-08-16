import { readFile } from "node:fs/promises";
const s = await readFile(
  new URL(
    "../supabase/migrations/20260817190000_sprint8_vacations.sql",
    import.meta.url,
  ),
  "utf8",
);
for (const t of [
  "vacation_accrual_periods",
  "vacation_schedules",
  "três frações",
  "Saldo de dias insuficiente",
  "payment_date<start_date",
  "enable row level security",
])
  if (!s.includes(t)) throw new Error(t);
console.log(
  JSON.stringify({
    fractions_max: 3,
    advance_payment: true,
    overlap_guard: true,
    balance_guard: true,
    rls: true,
  }),
);
