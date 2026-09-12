/**
 * O1-01b — 13º salário sobre as tabelas fiscais versionadas: teste de COMPORTAMENTO.
 *
 * Empacota `payroll-special.ts` (puro; puxa `progressiveLookup`/`bracketLookup` de
 * payroll-formula.ts) e EXECUTA `calculateThirteenthSalary` com as faixas federais
 * do seed. Antes do O1-01b o 13º lia INSS/IRRF do singleton `payroll_config` e não
 * tinha teste; agora consome as faixas versionadas e a matemática é a mesma do
 * motor do ADR 0003 (fonte única).
 *
 * Afere INSS progressivo + IRRF por faixa (banda do topo e banda intermediária com
 * deduzir), a 1ª parcela sem desconto, e a compensação da 1ª na 2ª parcela.
 * Mutação: mudar uma alíquota das faixas abaixo derruba os valores esperados.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "decimo-fiscal-test-"));
const bundlePath = join(dir, "payroll-special.bundle.mjs");
await build({
  entryPoints: ["src/lib/payroll-special.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundlePath,
  logLevel: "silent",
  external: ["node:*"],
});
const { calculateThirteenthSalary } = await import(bundlePath);

// Faixas federais idênticas ao seed de 20260908060000_o1_01_fiscal_tables.sql.
const inssBrackets = [
  { ate: 1518, aliquota: 0.075 },
  { ate: 2793.88, aliquota: 0.09 },
  { ate: 4190.83, aliquota: 0.12 },
  { ate: 8157.41, aliquota: 0.14 },
];
const irrfBrackets = [
  { ate: 2428.8, aliquota: 0, deduzir: 0 },
  { ate: 2826.65, aliquota: 0.075, deduzir: 182.16 },
  { ate: 3751.05, aliquota: 0.15, deduzir: 394.16 },
  { ate: 4664.68, aliquota: 0.225, deduzir: 675.49 },
  { ate: 999999999, aliquota: 0.275, deduzir: 908.73 },
];

function decimo(base, installment, firstInstallmentPaid) {
  return calculateThirteenthSalary({
    calculationBase: base,
    months: 12,
    installment,
    firstInstallmentPaid,
    inssBrackets,
    irrfBrackets,
  });
}

test("2a parcela: INSS progressivo + IRRF na banda do topo", () => {
  // entitlement 6000 → INSS = 113.85+114.8292+167.634+253.2838 = 649.60
  // IRRF base 5350.40 → 5350.40*0.275 - 908.73 = 562.63
  const r = decimo(6000, "segunda");
  assert.equal(r.entitlement, 6000);
  assert.equal(r.socialSecurity, 649.6);
  assert.equal(r.incomeTax, 562.63);
  assert.equal(r.deductions, 1212.23);
  assert.equal(r.netAmount, 4787.77);
});

test("2a parcela: IRRF na banda intermediaria com parcela a deduzir", () => {
  // entitlement 3000 → INSS 253.41; IRRF base 2746.59 → *0.075 - 182.16 = 23.83
  const r = decimo(3000, "segunda");
  assert.equal(r.socialSecurity, 253.41);
  assert.equal(r.incomeTax, 23.83);
});

test("1a parcela: metade do provento, sem INSS/IRRF", () => {
  const r = decimo(6000, "primeira");
  assert.equal(r.earnings, 3000);
  assert.equal(r.socialSecurity, 0);
  assert.equal(r.incomeTax, 0);
  assert.equal(r.deductions, 0);
});

test("2a parcela compensa a 1a parcela ja paga", () => {
  const r = decimo(6000, "segunda", 3000);
  assert.equal(r.firstInstallmentCompensation, 3000);
  assert.equal(r.deductions, 649.6 + 562.63 + 3000);
  assert.equal(r.netAmount, Number((6000 - r.deductions).toFixed(2)));
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
