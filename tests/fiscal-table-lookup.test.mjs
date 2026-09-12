/**
 * O1-01 — nó `table_lookup` do avaliador de fórmula: teste de COMPORTAMENTO.
 *
 * Empacota `payroll-formula.ts` (função pura, sem I/O) e EXECUTA o avaliador com
 * as faixas federais semeadas na migration. Afere o INSS progressivo em cada
 * limite de faixa e acima do teto, o IRRF por faixa com parcela a deduzir, e que
 * o passo `table_lookup` carrega `tableVersionId`+`tableChecksum` na memória de
 * cálculo (a prova defensável perante o TCE). Também: tabela ausente lança, nó
 * malformado é rejeitado no parse, e o serializador canônico cobre o novo nó
 * (senão o checksum da fórmula não mudaria ao trocar de tabela).
 *
 * Mutação: alterar qualquer alíquota das faixas abaixo derruba os valores
 * esperados; trocar a math de `progressiveLookup`/`bracketLookup` também.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "fiscal-lookup-test-"));
const bundlePath = join(dir, "payroll-formula.bundle.mjs");
await build({
  entryPoints: ["src/lib/payroll-formula.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundlePath,
  logLevel: "silent",
  external: ["node:*"],
});
const { evaluateFormulaAst, validateFormulaAst, stableFormulaJson } =
  await import(bundlePath);

// Faixas federais idênticas ao seed de 20260908060000_o1_01_fiscal_tables.sql.
const INSS = {
  versionId: "f1541b1e-0000-4000-8000-000000000011",
  checksum: "8a8683b1fe89704ed2b2e3aefcdc1bf7df282bf0da566f28be7f3640de785ac4",
  brackets: [
    { ate: 1518, aliquota: 0.075 },
    { ate: 2793.88, aliquota: 0.09 },
    { ate: 4190.83, aliquota: 0.12 },
    { ate: 8157.41, aliquota: 0.14 },
  ],
};
const IRRF = {
  versionId: "f1541b1e-0000-4000-8000-000000000012",
  checksum: "44335008d810fe710d55fdb26764a326e4bc5edd4e38e5618080c6199165b68e",
  brackets: [
    { ate: 2428.8, aliquota: 0, deduzir: 0 },
    { ate: 2826.65, aliquota: 0.075, deduzir: 182.16 },
    { ate: 3751.05, aliquota: 0.15, deduzir: 394.16 },
    { ate: 4664.68, aliquota: 0.225, deduzir: 675.49 },
    { ate: 999999999, aliquota: 0.275, deduzir: 908.73 },
  ],
};

const inssAst = {
  type: "table_lookup",
  table: "INSS_FEDERAL",
  mode: "progressive",
  base: { type: "variable", name: "inss_base" },
};
const irrfAst = {
  type: "table_lookup",
  table: "IRRF_FEDERAL",
  mode: "bracket",
  base: { type: "variable", name: "irrf_base" },
};

function inss(base) {
  const tables = new Map([["INSS_FEDERAL", INSS]]);
  return evaluateFormulaAst(inssAst, { inss_base: base }, tables);
}
function irrf(base) {
  const tables = new Map([["IRRF_FEDERAL", IRRF]]);
  return evaluateFormulaAst(irrfAst, { irrf_base: base }, tables);
}

const near = (got, want) =>
  assert.ok(Math.abs(got - want) < 1e-6, `esperado ${want}, obtido ${got}`);

test("INSS progressivo acumula por faixa em cada limite", () => {
  // No topo de cada faixa a contribuição é a soma das faixas anteriores cheias.
  near(inss(1518).rawValue, 113.85); // 1518*0.075
  near(inss(2793.88).rawValue, 113.85 + 1275.88 * 0.09);
  near(inss(4190.83).rawValue, 113.85 + 1275.88 * 0.09 + 1396.95 * 0.12);
  near(
    inss(8157.41).rawValue,
    113.85 + 1275.88 * 0.09 + 1396.95 * 0.12 + 3966.58 * 0.14,
  );
});

test("INSS trava no teto: base acima da ultima faixa nao passa do teto", () => {
  const teto = inss(8157.41).rawValue;
  near(inss(20000).rawValue, teto); // 951.6344
  near(inss(1000000).rawValue, teto);
});

test("IRRF aplica a faixa onde base<=ate com a parcela a deduzir", () => {
  near(irrf(2000).rawValue, 0); // faixa isenta
  near(irrf(3000).rawValue, 3000 * 0.15 - 394.16); // 55.84
  near(irrf(5000).rawValue, 5000 * 0.275 - 908.73); // 466.27
});

test("o passo table_lookup carrega versao e checksum na memoria", () => {
  const step = inss(2793.88).steps.find((s) => s.kind === "table_lookup");
  assert.ok(step, "passo table_lookup ausente na memoria de calculo");
  assert.equal(step.label, "INSS_FEDERAL");
  assert.equal(step.tableVersionId, INSS.versionId);
  assert.equal(step.tableChecksum, INSS.checksum);
  near(step.base, 2793.88);
});

test("tabela ausente no Map lanca em vez de silenciar zero", () => {
  assert.throws(
    () => evaluateFormulaAst(inssAst, { inss_base: 3000 }, new Map()),
    /tabela fiscal ausente: INSS_FEDERAL/,
  );
});

test("no table_lookup malformado e rejeitado no parse", () => {
  assert.throws(
    () =>
      validateFormulaAst({
        type: "table_lookup",
        table: "inss_minuscula",
        mode: "progressive",
        base: { type: "number", value: 1 },
      }),
    /table: código de tabela inválido/,
  );
  assert.throws(
    () =>
      validateFormulaAst({
        type: "table_lookup",
        table: "INSS",
        mode: "exponencial",
        base: { type: "number", value: 1 },
      }),
    /mode: modo de tabela não permitido/,
  );
  assert.throws(
    () =>
      validateFormulaAst({
        type: "table_lookup",
        table: "INSS",
        mode: "progressive",
        base: { type: "number", value: 1 },
        extra: 1,
      }),
    /campo não permitido/,
  );
});

test("o serializador canonico distingue tabelas diferentes", () => {
  const a = stableFormulaJson(validateFormulaAst(inssAst));
  const b = stableFormulaJson(validateFormulaAst(irrfAst));
  assert.notEqual(a, b); // trocar de tabela muda o checksum da formula
  assert.match(a, /"type":"table_lookup"/);
  assert.match(a, /"table":"INSS_FEDERAL"/);
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
