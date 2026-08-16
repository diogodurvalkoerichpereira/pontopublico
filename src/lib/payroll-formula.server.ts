import { createHash } from "node:crypto";
import {
  stableFormulaJson,
  validateFormulaAst,
  type PayrollFormulaAst,
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
