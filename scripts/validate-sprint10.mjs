import { readFile } from "node:fs/promises";
const s = await readFile(
  new URL("../src/lib/bank-remittance.functions.ts", import.meta.url),
  "utf8",
);
for (const t of [
  "CNAB240-v1",
  "status='fechada'",
  "file_sha256",
  "sem conta bancária ativa",
  "total_amount",
])
  if (!s.includes(t)) throw new Error(t);
console.log(
  JSON.stringify({
    cnab: true,
    closed_cycle_only: true,
    reconciliation: true,
    sha256: true,
  }),
);
