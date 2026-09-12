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

/** Modo de aplicação de uma tabela fiscal ao valor-base (ver ADR 0003). */
export type FiscalTableMode = "progressive" | "bracket";

export type PayrollFormulaAst =
  | { type: "number"; value: number }
  | { type: "variable"; name: PayrollFormulaVariable }
  | {
      type: "binary";
      operator: PayrollFormulaOperator;
      left: PayrollFormulaAst;
      right: PayrollFormulaAst;
    }
  // Consulta a uma tabela fiscal versionada. `table` é CÓDIGO, não dado — a
  // tabela chega pré-carregada no `Map` de tabelas, então o avaliador continua
  // função pura, sem I/O. INSS = "progressive" (acumula por faixa até o teto),
  // IRRF = "bracket" (faixa onde base<=ate: base*aliquota - deduzir).
  | {
      type: "table_lookup";
      table: string;
      mode: FiscalTableMode;
      base: PayrollFormulaAst;
    };

/** Uma faixa de tabela fiscal. `deduzir` só existe no modo bracket (IRRF). */
export interface FiscalBracket {
  ate: number;
  aliquota: number;
  deduzir?: number;
}

/** Versão vigente de uma tabela fiscal, pré-carregada para o avaliador. */
export interface FiscalTable {
  versionId: string;
  checksum: string;
  brackets: FiscalBracket[];
}

export interface FormulaStep {
  path: string;
  kind: "number" | "variable" | "binary" | "table_lookup";
  label: string;
  value: number;
  left?: number;
  right?: number;
  base?: number;
  tableVersionId?: string;
  tableChecksum?: string;
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
  if (node.type === "table_lookup") {
    assertExactKeys(node, ["type", "table", "mode", "base"], path);
    if (typeof node.table !== "string" || !/^[A-Z0-9_]+$/.test(node.table))
      throw new Error(`${path}.table: código de tabela inválido`);
    if (node.mode !== "progressive" && node.mode !== "bracket")
      throw new Error(`${path}.mode: modo de tabela não permitido`);
    const base = parseNode(node.base, `${path}.base`, depth + 1, counter);
    return {
      type: "table_lookup",
      table: node.table,
      mode: node.mode,
      base,
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
  if (ast.type === "table_lookup")
    return `{"base":${stableFormulaJson(ast.base)},"mode":${JSON.stringify(ast.mode)},"table":${JSON.stringify(ast.table)},"type":"table_lookup"}`;
  return `{"left":${stableFormulaJson(ast.left)},"operator":${JSON.stringify(ast.operator)},"right":${stableFormulaJson(ast.right)},"type":"binary"}`;
}

function safeResult(value: number, path: string): number {
  if (!Number.isFinite(value))
    throw new Error(`${path}: resultado inválido ou divisão por zero`);
  if (Math.abs(value) > 1_000_000_000_000_000)
    throw new Error(`${path}: resultado fora do limite`);
  return value;
}

/** INSS: soma `(min(base,ate)-prev)*aliquota` por faixa; o topo da última é o teto. */
export function progressiveLookup(
  base: number,
  brackets: FiscalBracket[],
): number {
  const sorted = [...brackets].sort((a, b) => a.ate - b.ate);
  let prev = 0;
  let acc = 0;
  for (const faixa of sorted) {
    if (base <= prev) break;
    const cap = Math.min(base, faixa.ate);
    acc += (cap - prev) * faixa.aliquota;
    prev = faixa.ate;
  }
  return acc;
}

/** IRRF: faixa onde `base<=ate` → `base*aliquota - deduzir` (nunca negativo). */
export function bracketLookup(base: number, brackets: FiscalBracket[]): number {
  const sorted = [...brackets].sort((a, b) => a.ate - b.ate);
  const faixa = sorted.find((f) => base <= f.ate) ?? sorted[sorted.length - 1];
  return Math.max(0, base * faixa.aliquota - (faixa.deduzir ?? 0));
}

function evaluateNode(
  ast: PayrollFormulaAst,
  variables: Partial<Record<PayrollFormulaVariable, number>>,
  tables: Map<string, FiscalTable>,
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
  if (ast.type === "table_lookup") {
    const table = tables.get(ast.table);
    if (!table) throw new Error(`${path}: tabela fiscal ausente: ${ast.table}`);
    const base = evaluateNode(
      ast.base,
      variables,
      tables,
      `${path}.base`,
      steps,
    );
    const value =
      ast.mode === "progressive"
        ? progressiveLookup(base, table.brackets)
        : bracketLookup(base, table.brackets);
    safeResult(value, path);
    // id e checksum da versão entram na memória de cálculo (defensável no TCE).
    steps.push({
      path,
      kind: "table_lookup",
      label: ast.table,
      value,
      base,
      tableVersionId: table.versionId,
      tableChecksum: table.checksum,
    });
    return value;
  }
  const left = evaluateNode(ast.left, variables, tables, `${path}.left`, steps);
  const right = evaluateNode(
    ast.right,
    variables,
    tables,
    `${path}.right`,
    steps,
  );
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
  tables: Map<string, FiscalTable> = new Map(),
  scale = 2,
  mode: PayrollRoundingMode = "half_up",
): FormulaEvaluation {
  const ast = validateFormulaAst(input);
  const steps: FormulaStep[] = [];
  const rawValue = evaluateNode(ast, variables, tables, "$", steps);
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
