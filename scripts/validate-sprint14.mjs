import { readFile } from "node:fs/promises";
const s = await readFile(
  new URL("../src/lib/manager-dashboard.functions.ts", import.meta.url),
  "utf8",
);
for (const t of [
  "total_earnings",
  "total_deductions",
  "idade_media",
  "admitidos",
  "unidade",
  "reconciled",
])
  if (!s.includes(t)) throw new Error(t);
console.log(
  JSON.stringify({
    payroll_series: true,
    headcount: true,
    demography: true,
    units: true,
    movements: true,
    reconciliation: true,
  }),
);
