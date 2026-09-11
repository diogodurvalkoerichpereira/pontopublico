/**
 * O1-07 (base) — motor de largura fixa: teste de COMPORTAMENTO (puro).
 *
 * Empacota `fixed-width.ts` e EXECUTA a formatacao posicional: num alinhado a
 * direita com zeros, alfa a esquerda com espacos/maiusculo, corte correto no
 * estouro, e a montagem do registro com validacao de contiguidade e comprimento
 * exato. E a base do CNAB 240 e do AFD/AEJ (formatos posicionais).
 *
 * Mutacao: trocar o alinhamento do num (padStart->padEnd) ou tirar a checagem de
 * contiguidade derruba.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "fixed-width-test-"));
const bundlePath = join(dir, "fixed-width.bundle.mjs");
await build({
  entryPoints: ["src/lib/fixed-width.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundlePath,
  logLevel: "silent",
  external: ["node:*"],
});
const { formatField, writeRecord, specLength } = await import(bundlePath);

test("num: alinhado a direita, preenchido com zeros", () => {
  assert.equal(
    formatField(123, { name: "n", start: 1, length: 6, type: "num" }),
    "000123",
  );
  // So digitos: pontuacao e removida.
  assert.equal(
    formatField("12.34", { name: "n", start: 1, length: 6, type: "num" }),
    "001234",
  );
  // Estouro: mantem os digitos menos significativos (corte a esquerda).
  assert.equal(
    formatField("1234567", { name: "n", start: 1, length: 4, type: "num" }),
    "4567",
  );
});

test("alfa: alinhado a esquerda, maiusculo, preenchido com espacos", () => {
  assert.equal(
    formatField("abc", { name: "a", start: 1, length: 5, type: "alfa" }),
    "ABC  ",
  );
  // Estouro: corta a direita.
  assert.equal(
    formatField("ABCDEF", { name: "a", start: 1, length: 3, type: "alfa" }),
    "ABC",
  );
});

test("writeRecord monta o registro contiguo no comprimento exato", () => {
  const specs = [
    { name: "banco", start: 1, length: 3, type: "num" },
    { name: "nome", start: 4, length: 7, type: "alfa" },
  ];
  assert.equal(specLength(specs), 10);
  const line = writeRecord(specs, { banco: 1, nome: "bb" }, 10);
  assert.equal(line, "001BB     ");
  assert.equal(line.length, 10);
});

test("writeRecord recusa spec nao contigua", () => {
  const specs = [
    { name: "a", start: 1, length: 3, type: "num" },
    { name: "b", start: 5, length: 2, type: "num" }, // deveria comecar em 4
  ];
  assert.throws(() => writeRecord(specs, { a: 1, b: 2 }, 5), /contigua/);
});

test("writeRecord recusa comprimento final diferente do esperado", () => {
  const specs = [{ name: "a", start: 1, length: 3, type: "num" }];
  assert.throws(() => writeRecord(specs, { a: 1 }, 240), /240/);
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
