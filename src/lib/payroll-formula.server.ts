import { createHash } from "node:crypto";
import {
  stableFormulaJson,
  validateFormulaAst,
  type PayrollFormulaAst,
  type FiscalBracket,
} from "./payroll-formula";

export function checksumFormulaAst(input: unknown): {
  ast: PayrollFormulaAst;
  checksum: string;
} {
  const ast = validateFormulaAst(input);
  const checksum = createHash("sha256")
    .update(stableFormulaJson(ast), "utf8")
    .digest("hex");
  return { ast, checksum };
}

/**
 * Serialização canônica das faixas de uma tabela fiscal: ordenadas por `ate`,
 * chaves em ordem alfabética (aliquota, ate, deduzir). É a base do checksum da
 * versão — o mesmo cálculo no seed da migration e no loader, para conferirem.
 */
export function stableFiscalBracketsJson(brackets: FiscalBracket[]): string {
  const parts = [...brackets]
    .sort((a, b) => a.ate - b.ate)
    .map((b) =>
      b.deduzir != null
        ? `{"aliquota":${b.aliquota},"ate":${b.ate},"deduzir":${b.deduzir}}`
        : `{"aliquota":${b.aliquota},"ate":${b.ate}}`,
    );
  return `[${parts.join(",")}]`;
}

export function checksumFiscalBrackets(brackets: FiscalBracket[]): string {
  return createHash("sha256")
    .update(stableFiscalBracketsJson(brackets), "utf8")
    .digest("hex");
}
