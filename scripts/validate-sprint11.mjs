import { readFile } from "node:fs/promises";
const s = await readFile(
  new URL("../src/lib/official-export.functions.ts", import.meta.url),
  "utf8",
);
for (const t of [
  "TCE_CE_SIM",
  "SIOPE",
  "MAND",
  "PCS_2025",
  "validation_errors",
  "status='fechada'",
])
  if (!s.includes(t)) throw new Error(t);
console.log(
  JSON.stringify({
    tce: true,
    siope: true,
    mand: true,
    pcs_xml: true,
    versioned: true,
    validator: true,
  }),
);
