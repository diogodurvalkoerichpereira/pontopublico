// Sprint 11 — exportações para órgãos de controle.
//
// Nenhum layout oficial está implementado: três dos quatro códigos produzem o
// mesmo CSV de cinco colunas. Este validador impede que os códigos voltem a se
// apresentar como layouts oficiais.
import { readFile } from "node:fs/promises";

const s = await readFile(
  new URL("../src/lib/official-export.functions.ts", import.meta.url),
  "utf8",
);

// Guarda de honestidade: os códigos precisam do prefixo RASCUNHO_.
for (const oficial of ["TCE_CE_SIM", "SIOPE", "MANAD", "MAND", "PCS_2025"]) {
  const semPrefixo = new RegExp(`['"\`]${oficial}['"\`]`);
  if (semPrefixo.test(s))
    throw new Error(
      `Código '${oficial}' sem prefixo RASCUNHO_: o layout oficial não está implementado.`,
    );
}
for (const esperado of [
  "RASCUNHO_TCE_CE_SIM",
  "RASCUNHO_SIOPE",
  "RASCUNHO_MANAD",
  "RASCUNHO_PCS",
])
  if (!s.includes(esperado)) throw new Error(`Falta o código ${esperado}.`);
if (!s.includes('conformanceOf("exportacao-oficial")'))
  throw new Error("A resposta deve carregar o estado de conformidade.");

// Travas funcionais que devem permanecer.
for (const t of ["validation_errors", "status='fechada'"])
  if (!s.includes(t)) throw new Error(t);

console.log(
  JSON.stringify({
    layouts_oficiais: false,
    rotulo_honesto: true,
    versioned: true,
    validator: true,
    closed_cycle_only: true,
  }),
);
