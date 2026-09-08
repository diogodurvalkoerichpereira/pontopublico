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
