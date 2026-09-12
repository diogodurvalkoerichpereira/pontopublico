#!/usr/bin/env node
/**
 * Catraca de qualidade.
 *
 * O repositório entra em CI com 274 erros de TypeScript e ~2015 de ESLint.
 * Exigir zero desde já deixaria o pipeline vermelho permanentemente, e um
 * pipeline sempre vermelho não é gate — é ruído que se aprende a ignorar.
 *
 * Esta catraca faz o oposto: fixa o número atual como teto e falha se ele
 * subir. O débito existente fica registrado e visível, mas para de crescer, e
 * cada correção que baixa o teto o baixa para sempre.
 *
 * Uso:
 *   node scripts/quality-ratchet.mjs           # verifica contra o teto
 *   node scripts/quality-ratchet.mjs --update  # grava o teto atual
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASELINE_FILE = new URL("../quality-baseline.json", import.meta.url);

/** Executa o comando e conta as linhas que casam com o padrão. */
function count(command, pattern) {
  let output = "";
  try {
    output = execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // tsc e eslint saem com código != 0 quando há problemas; a saída é o dado.
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  return output.split("\n").filter((l) => pattern.test(l)).length;
}

/** Total de problemas do ESLint, lido do relatório JSON. */
function countEslint() {
  let output = "";
  try {
    output = execSync("npx eslint . -f json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    output = String(e.stdout ?? "");
  }
  const start = output.indexOf("[");
  if (start === -1) throw new Error("ESLint não produziu relatório JSON.");
  const report = JSON.parse(output.slice(start));
  return report.reduce((total, f) => total + f.errorCount + f.warningCount, 0);
}

const measured = {
  typescript: count("npx tsc --noEmit", /error TS\d+/),
  eslint: countEslint(),
};

const update = process.argv.includes("--update");

if (update || !existsSync(BASELINE_FILE)) {
  writeFileSync(BASELINE_FILE, `${JSON.stringify(measured, null, 2)}\n`);
  console.log("Teto gravado:", JSON.stringify(measured));
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
let failed = false;
const melhorou = {};

for (const [tool, limit] of Object.entries(baseline)) {
  const atual = measured[tool];
  if (atual > limit) {
    console.error(
      `✗ ${tool}: ${atual} problemas, teto é ${limit}. ` +
        `Esta mudança acrescentou ${atual - limit}.`,
    );
    failed = true;
  } else {
    if (atual < limit) melhorou[tool] = atual;
    console.log(`✓ ${tool}: ${atual} (teto ${limit})`);
  }
}

if (Object.keys(melhorou).length) {
  console.log(
    "\nO teto pode baixar. Rode `node scripts/quality-ratchet.mjs --update` " +
      "e commite quality-baseline.json:",
    JSON.stringify(melhorou),
  );
}

process.exit(failed ? 1 : 0);
