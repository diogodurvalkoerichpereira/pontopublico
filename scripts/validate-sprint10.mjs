// Sprint 10 — remessa bancária.
//
// Este validador não afirma conformidade com CNAB 240, porque o módulo não a
// tem. Ele garante o oposto: que o código não volte a se rotular como padrão
// oficial, e que as travas reais (folha fechada, checksum) continuem de pé.
import { readFile } from "node:fs/promises";

const s = await readFile(
  new URL("../src/lib/bank-remittance.functions.ts", import.meta.url),
  "utf8",
);

// Guarda de honestidade: nenhum rótulo pode sugerir conformidade CNAB 240.
if (/['"`]CNAB240-v1['"`]/.test(s))
  throw new Error(
    "Rótulo 'CNAB240-v1' de volta: o arquivo gerado não é CNAB 240.",
  );
if (!s.includes("RASCUNHO-NAO-CNAB240-v1"))
  throw new Error("layout_version deve declarar que não é CNAB 240.");
if (!s.includes('conformanceOf("remessa-bancaria")'))
  throw new Error("A resposta deve carregar o estado de conformidade.");

// Travas funcionais que devem permanecer.
for (const t of [
  "status='fechada'",
  "file_sha256",
  "sem conta bancária ativa",
  "total_amount",
])
  if (!s.includes(t)) throw new Error(t);

console.log(
  JSON.stringify({
    cnab240: false,
    rotulo_honesto: true,
    closed_cycle_only: true,
    reconciliation: true,
    sha256: true,
  }),
);
