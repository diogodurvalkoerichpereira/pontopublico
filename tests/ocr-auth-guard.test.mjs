/**
 * Guard de autenticação dos proxies de OCR (dívida menor do BACKLOG, seção
 * "Dívidas menores registradas").
 *
 * extractAtestadoOCR/extractDocumentoOCR não tocam dado de tenant (por isso
 * ficam na ALLOWLIST de tests/authorization-coverage.test.mjs), mas consomem a
 * LOVABLE_API_KEY paga a cada chamada — sem `requireAuth` eram endpoints
 * públicos, abertos a abuso do serviço por qualquer um na internet. Este teste
 * varre por AST (compiler API do TypeScript, como o teste de cobertura de
 * tenant) e falha se `.middleware([requireAuth])` sumir da cadeia de qualquer
 * um dos dois handlers — não lê o arquivo como string.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  { file: "src/lib/ocr.functions.ts", handler: "extractAtestadoOCR" },
  { file: "src/lib/document-ocr.functions.ts", handler: "extractDocumentoOCR" },
];

/** true se algum `.middleware(ARGS)` na cadeia de `initializer` inclui um array com `requireAuth`. */
function hasRequireAuthMiddleware(initializer) {
  let found = false;
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "middleware" &&
      n.arguments.length &&
      ts.isArrayLiteralExpression(n.arguments[0])
    ) {
      const names = n.arguments[0].elements
        .filter(ts.isIdentifier)
        .map((el) => el.text);
      if (names.includes("requireAuth")) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(initializer);
  return found;
}

function findExportedInitializer(path, exportName) {
  const src = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let initializer = null;
  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === exportName &&
          decl.initializer
        ) {
          initializer = decl.initializer;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return initializer;
}

for (const { file, handler } of TARGETS) {
  test(`${handler} exige requireAuth (evita abuso público da API de OCR paga)`, () => {
    const initializer = findExportedInitializer(join(root, file), handler);
    assert.ok(initializer, `${handler} não encontrado em ${file}`);
    assert.equal(
      hasRequireAuthMiddleware(initializer),
      true,
      `${handler} perdeu o .middleware([requireAuth]) — vira endpoint público de novo`,
    );
  });
}
