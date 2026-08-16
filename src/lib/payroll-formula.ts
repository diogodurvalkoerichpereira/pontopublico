export const PAYROLL_FORMULA_VARIABLES = [
  "salary_base",
  "fixed_amount",
  "quantity",
  "hours",
  "days",
  "dependency_total",
  "inss_base",
  "irrf_base",
  "fgts_base",
  "patronal_base",
  "dependents_ir",
] as const;

export type PayrollFormulaVariable = (typeof PAYROLL_FORMULA_VARIABLES)[number];
export type PayrollFormulaOperator = "+" | "-" | "*" | "/";

export type PayrollFormulaAst =
  | { type: "number"; value: number }
  | { type: "variable"; name: PayrollFormulaVariable }
  | {
      type: "binary";
      operator: PayrollFormulaOperator;
      left: PayrollFormulaAst;
      right: PayrollFormulaAst;
    };

export interface FormulaStep {
  path: string;
  kind: "number" | "variable" | "binary";
  label: string;
  value: number;
  left?: number;
  right?: number;
}

export interface FormulaEvaluation {
  rawValue: number;
  roundedValue: number;
  rounding: { scale: number; mode: PayrollRoundingMode };
  steps: FormulaStep[];
}

export type PayrollRoundingMode = "half_up" | "half_even" | "truncate";

const VARIABLE_SET = new Set<string>(PAYROLL_FORMULA_VARIABLES);
const OPERATOR_SET = new Set<string>(["+", "-", "*", "/"]);

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  path: string,
) {
  const invalid = Object.keys(value).find((key) => !allowed.includes(key));
  if (invalid) throw new Error(`${path}.${invalid}: campo não permitido`);
}

function parseNode(
  input: unknown,
  path: string,
  depth: number,
  counter: { value: number },
): PayrollFormulaAst {
  if (depth > 12) throw new Error(`${path}: fórmula excede 12 níveis`);
  counter.value += 1;
  if (counter.value > 63) throw new Error(`${path}: fórmula excede 63 nós`);
  if (!input || Array.isArray(input) || typeof input !== "object")
    throw new Error(`${path}: nó deve ser um objeto`);
  const node = input as Record<string, unknown>;

  if (node.type === "number") {
    assertExactKeys(node, ["type", "value"], path);
    if (typeof node.value !== "number" || !Number.isFinite(node.value))
      throw new Error(`${path}.value: número finito obrigatório`);
    if (Math.abs(node.value) > 1_000_000_000_000)
      throw new Error(`${path}.value: número fora do limite`);
    return { type: "number", value: node.value };
  }
  if (node.type === "variable") {
    assertExactKeys(node, ["type", "name"], path);
    if (typeof node.name !== "string" || !VARIABLE_SET.has(node.name))
      throw new Error(`${path}.name: variável não permitida`);
    return {
      type: "variable",
      name: node.name as PayrollFormulaVariable,
    };
  }
  if (node.type === "binary") {
    assertExactKeys(node, ["type", "operator", "left", "right"], path);
    if (typeof node.operator !== "string" || !OPERATOR_SET.has(node.operator))
      throw new Error(`${path}.operator: operador não permitido`);
    const left = parseNode(node.left, `${path}.left`, depth + 1, counter);
    const right = parseNode(node.right, `${path}.right`, depth + 1, counter);
    if (node.operator === "/" && right.type === "number" && right.value === 0)
      throw new Error(`${path}.right: divisão literal por zero`);
    return {
      type: "binary",
      operator: node.operator as PayrollFormulaOperator,
      left,
      right,
    };
  }
  throw new Error(`${path}.type: tipo de nó não permitido`);
}

export function validateFormulaAst(input: unknown): PayrollFormulaAst {
  return parseNode(input, "$", 0, { value: 0 });
}

export function stableFormulaJson(ast: PayrollFormulaAst): string {
  if (ast.type === "number")
    return JSON.stringify({ type: ast.type, value: ast.value });
  if (ast.type === "variable")
    return JSON.stringify({ name: ast.name, type: ast.type });
  return `{"left":${stableFormulaJson(ast.left)},"operator":${JSON.stringify(ast.operator)},"right":${stableFormulaJson(ast.right)},"type":"binary"}`;
}

function safeResult(value: number, path: string): number {
  if (!Number.isFinite(value))
    throw new Error(`${path}: resultado inválido ou divisão por zero`);
  if (Math.abs(value) > 1_000_000_000_000_000)
    throw new Error(`${path}: resultado fora do limite`);
  return value;
}

function evaluateNode(
  ast: PayrollFormulaAst,
  variables: Partial<Record<PayrollFormulaVariable, number>>,
  path: string,
  steps: FormulaStep[],
): number {
  if (ast.type === "number") {
    steps.push({
      path,
      kind: "number",
      label: String(ast.value),
      value: ast.value,
    });
    return ast.value;
  }
  if (ast.type === "variable") {
    const value = Number(variables[ast.name] ?? 0);
    safeResult(value, path);
    steps.push({ path, kind: "variable", label: ast.name, value });
    return value;
  }
  const left = evaluateNode(ast.left, variables, `${path}.left`, steps);
  const right = evaluateNode(ast.right, variables, `${path}.right`, steps);
  let value: number;
  switch (ast.operator) {
    case "+":
      value = left + right;
      break;
    case "-":
      value = left - right;
      break;
    case "*":
      value = left * right;
      break;
    case "/":
      if (right === 0) throw new Error(`${path}.right: divisão por zero`);
      value = left / right;
      break;
  }
  value = safeResult(value, path);
  steps.push({
    path,
    kind: "binary",
    label: ast.operator,
    left,
    right,
    value,
  });
  return value;
}

export function roundPayrollValue(
  value: number,
  scale: number,
  mode: PayrollRoundingMode,
): number {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6)
    throw new Error("Escala de arredondamento inválida");
  const factor = 10 ** scale;
  const scaled = Math.abs(value) * factor;
  let integer: number;
  if (mode === "truncate") integer = Math.floor(scaled + 1e-10);
  else if (mode === "half_even") {
    const floor = Math.floor(scaled);
    const fraction = scaled - floor;
    if (Math.abs(fraction - 0.5) < 1e-10)
      integer = floor % 2 === 0 ? floor : floor + 1;
    else integer = Math.round(scaled);
  } else integer = Math.floor(scaled + 0.5 + 1e-10);
  return (Math.sign(value) * integer) / factor;
}

export function evaluateFormulaAst(
  input: unknown,
  variables: Partial<Record<PayrollFormulaVariable, number>>,
  scale = 2,
  mode: PayrollRoundingMode = "half_up",
): FormulaEvaluation {
  const ast = validateFormulaAst(input);
  const steps: FormulaStep[] = [];
  const rawValue = evaluateNode(ast, variables, "$", steps);
  return {
    rawValue,
    roundedValue: roundPayrollValue(rawValue, scale, mode),
    rounding: { scale, mode },
    steps,
  };
}

export function formulaAstFromTemplate(input: {
  variable: PayrollFormulaVariable;
  operator: PayrollFormulaOperator;
  operand: number;
  adjustmentOperator?: PayrollFormulaOperator | null;
  adjustment?: number | null;
}): PayrollFormulaAst {
  const first: PayrollFormulaAst = {
    type: "binary",
    operator: input.operator,
    left: { type: "variable", name: input.variable },
    right: { type: "number", value: input.operand },
  };
  if (!input.adjustmentOperator || input.adjustment == null) return first;
  return {
    type: "binary",
    operator: input.adjustmentOperator,
    left: first,
    right: { type: "number", value: input.adjustment },
  };
}
