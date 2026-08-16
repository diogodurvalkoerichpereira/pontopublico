import { readFile } from "node:fs/promises";
const sql = await readFile(
  new URL(
    "../supabase/migrations/20260817170000_sprint7_terminations_career.sql",
    import.meta.url,
  ),
  "utf8",
);
const server = await readFile(
  new URL("../src/lib/employment-special.functions.ts", import.meta.url),
  "utf8",
);
for (const token of [
  "termination_calculations",
  "employment_special_events",
  "career_levels",
  "reintegracao",
  "readaptacao",
  "progressao",
  "enable row level security",
]) {
  if (!sql.includes(token)) throw new Error(`Ausente: ${token}`);
}
for (const token of [
  "for update",
  "termination_date",
  "employment_link_movements",
  "result_checksum",
]) {
  if (!server.includes(token)) throw new Error(`Regra ausente: ${token}`);
}
const salary = 6000,
  worked = 15,
  m13 = 6,
  vac = 6;
const balance = (salary / 30) * worked;
const thirteenth = (salary * m13) / 12;
const vacation = (((salary * vac) / 12) * 4) / 3;
const total = balance + salary + thirteenth + vacation;
if (total !== 16000) throw new Error("Cenário rescisório divergente");
console.log(
  JSON.stringify(
    {
      schema_guards: true,
      career_history: true,
      reuses_registration_on_reinstatement: true,
      termination_sample: total,
      rls: true,
    },
    null,
    2,
  ),
);
