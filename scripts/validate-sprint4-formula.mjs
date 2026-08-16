import {
  evaluateFormulaAst,
  formulaAstFromTemplate,
  validateFormulaAst,
} from "../src/lib/payroll-formula.ts";

const ast = formulaAstFromTemplate({
  variable: "salary_base",
  operator: "*",
  operand: 0.1,
});
const result = evaluateFormulaAst(ast, { salary_base: 5000 }, 2, "half_up");
if (result.roundedValue !== 500)
  throw new Error("Fórmula salário*10% divergiu");

let injectionGuard = false;
try {
  validateFormulaAst({
    type: "function",
    name: "eval",
    arguments: ["process.exit()"],
  });
} catch (error) {
  injectionGuard = String(error).includes("$.type");
}
if (!injectionGuard) throw new Error("Nó de função não permitida foi aceito");

let divisionGuard = false;
try {
  validateFormulaAst({
    type: "binary",
    operator: "/",
    left: { type: "number", value: 1 },
    right: { type: "number", value: 0 },
  });
} catch (error) {
  divisionGuard = String(error).includes("$.right");
}
if (!divisionGuard) throw new Error("Divisão literal por zero foi aceita");

const halfUp = evaluateFormulaAst(
  { type: "number", value: 1.005 },
  {},
  2,
  "half_up",
).roundedValue;
const halfEven = evaluateFormulaAst(
  { type: "number", value: 1.005 },
  {},
  2,
  "half_even",
).roundedValue;
if (halfUp !== 1.01 || halfEven !== 1)
  throw new Error(`Arredondamento divergente: ${halfUp}/${halfEven}`);

console.log(
  JSON.stringify({
    ast_allowed: true,
    injection_guard: injectionGuard,
    division_by_zero_guard: divisionGuard,
    sample_result: result.roundedValue,
    half_up: halfUp,
    half_even: halfEven,
    trace_steps: result.steps.length,
  }),
);
