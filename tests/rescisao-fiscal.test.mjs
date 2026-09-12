/**
 * O1-05 — retencoes da rescisao sobre as tabelas fiscais versionadas: teste de
 * COMPORTAMENTO (puro).
 *
 * Empacota `payroll-special.ts` (puro; puxa `progressiveLookup`/`bracketLookup` de
 * payroll-formula.ts) e EXECUTA `calculateTerminationTaxes` com as faixas federais
 * do seed. Antes do O1-05 a rescisao nao retinha INSS/IRRF (net = total - descontos
 * manuais); agora retem pelo mesmo motor do ADR 0003.
 *
 * Confere contra calculo manual: INSS progressivo + IRRF por faixa sobre o saldo de
 * salario (competencia) e sobre o 13o proporcional (tributacao EXCLUSIVA, base
 * propria). E afere a ISENCAO das verbas indenizatorias: variar aviso/ferias/FGTS
 * nao muda um centavo de imposto.
 *
 * Mutacao: somar `vacationAmount`/`noticeAmount` a base, ou remover a trilha do 13o,
 * derruba os valores esperados.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "rescisao-fiscal-test-"));
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
const { calculateTerminationTaxes } = await import(bundlePath);

// Faixas federais identicas ao seed de 20260908060000_o1_01_fiscal_tables.sql.
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

function taxes(over = {}) {
  return calculateTerminationTaxes({
    salaryBalance: 3000,
    thirteenthAmount: 3000,
    noticeAmount: 6000,
    vacationAmount: 4000,
    fgtsPenalty: 0,
    inssBrackets,
    irrfBrackets,
    ...over,
  });
}

test("INSS progressivo + IRRF por faixa sobre saldo e 13o (tributacao exclusiva)", () => {
  // saldo 3000 -> INSS = 113.85 + 114.8292 + 24.7344 = 253.41
  // IRRF base 2746.59 -> 2746.59*0.075 - 182.16 = 23.83
  // 13o 3000 -> mesma trilha (base propria): INSS 253.41, IRRF 23.83
  const r = taxes();
  assert.equal(r.inssSalario, 253.41);
  assert.equal(r.irrfSalario, 23.83);
  assert.equal(r.inssThirteenth, 253.41);
  assert.equal(r.irrfThirteenth, 23.83);
  assert.equal(r.inssTotal, 506.82);
  assert.equal(r.irrfTotal, 47.66);
});

test("o 13o e tributado a parte, nao somado a base do salario", () => {
  // Se o 13o entrasse na base do salario (6000), o INSS bateria no teto (~649.60)
  // e o IRRF na banda de 27,5% — bem acima da soma de duas trilhas de 3000.
  const juntas = taxes();
  assert.ok(
    juntas.inssTotal < 649.6,
    "13o nao pode compor a base do salario (INSS somaria ao teto)",
  );
});

test("verbas indenizatorias sao isentas: variar aviso/ferias/FGTS nao muda o imposto", () => {
  const base = taxes();
  const comIndenizacoesAltas = taxes({
    noticeAmount: 50000,
    vacationAmount: 90000,
    fgtsPenalty: 40000,
  });
  assert.equal(comIndenizacoesAltas.inssTotal, base.inssTotal);
  assert.equal(comIndenizacoesAltas.irrfTotal, base.irrfTotal);
  // ...mas o total isento e contabilizado para auditoria.
  assert.equal(comIndenizacoesAltas.exemptTotal, 180000);
});

test("sem verbas tributaveis nao ha retencao", () => {
  const r = taxes({ salaryBalance: 0, thirteenthAmount: 0 });
  assert.equal(r.inssTotal, 0);
  assert.equal(r.irrfTotal, 0);
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
