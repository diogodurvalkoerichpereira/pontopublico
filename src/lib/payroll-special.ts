// A matemática fiscal (faixa progressiva / tabela por faixa) vem do motor do ADR
// 0003 — fonte única. As faixas chegam de `loadFiscalTables` (versionadas, com
// checksum), não mais do singleton `payroll_config` (congelado no O1-01b).
import {
  progressiveLookup,
  bracketLookup,
  type FiscalBracket,
} from "./payroll-formula";

const round2 = (value: number) => Number(value.toFixed(2));

function utcDate(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`);
}

export function countThirteenthSalaryMonths(
  year: number,
  admissionDate: string,
  terminationDate?: string | null,
) {
  const admission = utcDate(admissionDate);
  const termination = terminationDate ? utcDate(terminationDate) : null;
  let months = 0;
  for (let month = 0; month < 12; month += 1) {
    const monthStart = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(Date.UTC(year, month + 1, 0));
    const start = admission > monthStart ? admission : monthStart;
    const end = termination && termination < monthEnd ? termination : monthEnd;
    if (end < start) continue;
    const calendarDays =
      Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (calendarDays >= 15) months += 1;
  }
  return months;
}

export function calculateThirteenthSalary(input: {
  calculationBase: number;
  months: number;
  installment: "primeira" | "segunda";
  firstInstallmentPaid?: number;
  // Faixas das tabelas fiscais vigentes (INSS = progressive, IRRF = bracket).
  inssBrackets: FiscalBracket[];
  irrfBrackets: FiscalBracket[];
}) {
  const months = Math.max(0, Math.min(12, Math.trunc(input.months)));
  const entitlement = Number(
    ((Math.max(0, input.calculationBase) * months) / 12).toFixed(2),
  );
  if (input.installment === "primeira") {
    const earnings = Number((entitlement / 2).toFixed(2));
    return {
      entitlement,
      earnings,
      socialSecurity: 0,
      incomeTax: 0,
      firstInstallmentCompensation: 0,
      deductions: 0,
      netAmount: earnings,
    };
  }
  // INSS progressivo: o teto é o topo da última faixa (progressiveLookup para
  // por faixa). IRRF: faixa onde base<=ate, base*aliquota - deduzir.
  const socialSecurity = round2(
    progressiveLookup(entitlement, input.inssBrackets),
  );
  const incomeTax = round2(
    bracketLookup(
      Math.max(0, entitlement - socialSecurity),
      input.irrfBrackets,
    ),
  );
  const firstInstallmentCompensation = Number(
    Math.max(0, input.firstInstallmentPaid ?? 0).toFixed(2),
  );
  const deductions = Number(
    (socialSecurity + incomeTax + firstInstallmentCompensation).toFixed(2),
  );
  return {
    entitlement,
    earnings: entitlement,
    socialSecurity,
    incomeTax,
    firstInstallmentCompensation,
    deductions,
    netAmount: Number((entitlement - deductions).toFixed(2)),
  };
}

export interface TerminationTaxInput {
  // Verbas TRIBUTAVEIS
  salaryBalance: number; // saldo de salario — competencia final (INSS + IRRF normais)
  thirteenthAmount: number; // 13o proporcional — tributacao EXCLUSIVA (base propria)
  // Verbas ISENTAS — informadas para deixar a isencao explicita e auditavel:
  noticeAmount: number; // aviso previo indenizado — isento (STJ REsp 1.230.957; verba indenizatoria)
  vacationAmount: number; // ferias indenizadas + 1/3 — isentas (Sumula 386 STJ; art. 6 V Lei 7.713)
  fgtsPenalty: number; // saldo/multa FGTS — isento
  inssBrackets: FiscalBracket[];
  irrfBrackets: FiscalBracket[];
}

export interface TerminationTaxResult {
  inssSalario: number;
  irrfSalario: number;
  inssThirteenth: number;
  irrfThirteenth: number;
  inssTotal: number;
  irrfTotal: number;
  taxableSalary: number; // base tributada da competencia
  taxableThirteenth: number; // base tributada do 13o (exclusiva)
  exemptTotal: number; // verbas indenizatorias fora da base (auditoria)
}

/**
 * Retencoes da rescisao pelo motor fiscal versionado (ADR 0003). Duas trilhas
 * independentes de tributacao:
 *  - Competencia final: INSS progressivo sobre o saldo de salario; IRRF por faixa
 *    sobre (saldo - INSS).
 *  - 13o proporcional: tributacao EXCLUSIVA — base propria, nao soma a do salario;
 *    INSS progressivo e IRRF por faixa sobre a propria verba.
 * Aviso previo indenizado, ferias indenizadas + 1/3 e FGTS/multa sao verbas
 * indenizatorias: NAO integram a base (isencao pacificada). Recebe-las torna a
 * isencao explicita e o `exemptTotal` conferivel no termo.
 */
export function calculateTerminationTaxes(
  input: TerminationTaxInput,
): TerminationTaxResult {
  const salary = Math.max(0, input.salaryBalance);
  const thirteenth = Math.max(0, input.thirteenthAmount);
  const inssSalario = round2(progressiveLookup(salary, input.inssBrackets));
  const irrfSalario = round2(
    bracketLookup(Math.max(0, salary - inssSalario), input.irrfBrackets),
  );
  const inssThirteenth = round2(
    progressiveLookup(thirteenth, input.inssBrackets),
  );
  const irrfThirteenth = round2(
    bracketLookup(Math.max(0, thirteenth - inssThirteenth), input.irrfBrackets),
  );
  return {
    inssSalario,
    irrfSalario,
    inssThirteenth,
    irrfThirteenth,
    inssTotal: round2(inssSalario + inssThirteenth),
    irrfTotal: round2(irrfSalario + irrfThirteenth),
    taxableSalary: salary,
    taxableThirteenth: thirteenth,
    exemptTotal: round2(
      Math.max(0, input.noticeAmount) +
        Math.max(0, input.vacationAmount) +
        Math.max(0, input.fgtsPenalty),
    ),
  };
}
