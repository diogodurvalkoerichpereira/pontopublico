export type ProgressiveBand = { ate: number; aliquota: number };
export type IncomeTaxBand = { ate: number; aliquota: number; deduzir: number };

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

export function calculateProgressiveContribution(
  base: number,
  bands: ProgressiveBand[],
  ceiling: number,
) {
  const limited = Math.max(0, Math.min(base, ceiling));
  let total = 0;
  let previous = 0;
  for (const band of [...bands].sort((a, b) => a.ate - b.ate)) {
    if (limited <= previous) break;
    const top = Math.min(limited, band.ate);
    total += Math.max(0, top - previous) * band.aliquota;
    previous = band.ate;
  }
  return Number(total.toFixed(2));
}

export function calculateIncomeTax(
  base: number,
  bands: IncomeTaxBand[],
  dependentDeduction = 0,
  dependents = 0,
) {
  const taxable = Math.max(0, base - dependentDeduction * dependents);
  const band = [...bands]
    .sort((a, b) => a.ate - b.ate)
    .find((item) => taxable <= item.ate);
  if (!band) return 0;
  return Number(Math.max(0, taxable * band.aliquota - band.deduzir).toFixed(2));
}

export function calculateThirteenthSalary(input: {
  calculationBase: number;
  months: number;
  installment: "primeira" | "segunda";
  firstInstallmentPaid?: number;
  socialSecurityBands: ProgressiveBand[];
  socialSecurityCeiling: number;
  incomeTaxBands: IncomeTaxBand[];
  dependentDeduction?: number;
  dependents?: number;
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
  const socialSecurity = calculateProgressiveContribution(
    entitlement,
    input.socialSecurityBands,
    input.socialSecurityCeiling,
  );
  const incomeTax = calculateIncomeTax(
    Math.max(0, entitlement - socialSecurity),
    input.incomeTaxBands,
    input.dependentDeduction,
    input.dependents,
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
