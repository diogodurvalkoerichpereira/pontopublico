// Lógica de cálculo de horas e folha (executada no client; sem dependências de servidor)
import type { Database } from "@/integrations/supabase/types";

type WeeklyConfig = {
  [day: string]: { start: string; end: string; break_min?: number } | undefined;
};
type RotativeConfig = {
  pattern: "12x36" | "6x1" | "5x2" | string;
  shift_start?: string;
  shift_end?: string;
  reference_date?: string;
};

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** horas previstas no dia segundo a escala */
export function expectedMinutesForDay(
  date: Date,
  schedule: { tipo: "fixed_weekly" | "rotative"; config: WeeklyConfig | RotativeConfig },
): number {
  if (schedule.tipo === "fixed_weekly") {
    const cfg = schedule.config as WeeklyConfig;
    const day = DAYS[date.getDay()];
    const slot = cfg[day];
    if (!slot) return 0;
    const dur = toMin(slot.end) - toMin(slot.start) - (slot.break_min ?? 0);
    return Math.max(0, dur);
  }
  // rotative
  const cfg = schedule.config as RotativeConfig;
  if (!cfg.reference_date || !cfg.shift_start || !cfg.shift_end) return 0;
  const ref = new Date(cfg.reference_date + "T00:00:00");
  const diffDays = Math.floor((date.getTime() - ref.getTime()) / 86_400_000);
  const dur = toMin(cfg.shift_end) - toMin(cfg.shift_start);
  if (cfg.pattern === "12x36") return diffDays % 2 === 0 ? Math.max(0, dur) : 0;
  if (cfg.pattern === "6x1") return diffDays % 7 === 6 ? 0 : Math.max(0, dur);
  if (cfg.pattern === "5x2") {
    const dow = (diffDays % 7 + 7) % 7;
    return dow >= 5 ? 0 : Math.max(0, dur);
  }
  return Math.max(0, dur);
}

export type TimeEntry = Database["public"]["Tables"]["time_entries"]["Row"];

/** soma minutos trabalhados em um dia a partir das batidas (pareadas) */
export function workedMinutesForDay(entries: TimeEntry[]): number {
  if (!entries.length) return 0;
  const ordered = [...entries].sort((a, b) => new Date(a.entry_at).getTime() - new Date(b.entry_at).getTime());
  let total = 0;
  let lastIn: Date | null = null;
  for (const e of ordered) {
    const t = new Date(e.entry_at);
    if (e.tipo === "entrada" || e.tipo === "volta_almoco") lastIn = t;
    else if ((e.tipo === "saida_almoco" || e.tipo === "saida") && lastIn) {
      total += Math.max(0, (t.getTime() - lastIn.getTime()) / 60000);
      lastIn = null;
    }
  }
  return Math.round(total);
}

/** minutos trabalhados entre 22h-5h em um dia (adicional noturno) */
export function nightMinutesForDay(entries: TimeEntry[]): number {
  if (!entries.length) return 0;
  const ordered = [...entries].sort((a, b) => new Date(a.entry_at).getTime() - new Date(b.entry_at).getTime());
  let total = 0;
  let lastIn: Date | null = null;
  for (const e of ordered) {
    const t = new Date(e.entry_at);
    if (e.tipo === "entrada" || e.tipo === "volta_almoco") lastIn = t;
    else if ((e.tipo === "saida_almoco" || e.tipo === "saida") && lastIn) {
      total += overlapWithNight(lastIn, t);
      lastIn = null;
    }
  }
  return Math.round(total);
}

function overlapWithNight(start: Date, end: Date): number {
  // Quebra em intervalos por dia e calcula overlap com [22:00, 05:00)
  let mins = 0;
  let cur = new Date(start);
  while (cur < end) {
    const nextDay = new Date(cur); nextDay.setHours(24, 0, 0, 0);
    const segEnd = nextDay < end ? nextDay : end;
    // janela 22:00-24:00 do mesmo dia
    const w1Start = new Date(cur); w1Start.setHours(22, 0, 0, 0);
    const w1End = new Date(cur); w1End.setHours(24, 0, 0, 0);
    mins += overlapMin(cur, segEnd, w1Start, w1End);
    // janela 00:00-05:00 do mesmo dia
    const w2Start = new Date(cur); w2Start.setHours(0, 0, 0, 0);
    const w2End = new Date(cur); w2End.setHours(5, 0, 0, 0);
    mins += overlapMin(cur, segEnd, w2Start, w2End);
    cur = segEnd;
  }
  return mins;
}
function overlapMin(aS: Date, aE: Date, bS: Date, bE: Date): number {
  const s = Math.max(aS.getTime(), bS.getTime());
  const e = Math.min(aE.getTime(), bE.getTime());
  return e > s ? (e - s) / 60000 : 0;
}

export type INSSFaixa = { ate: number; aliquota: number };
export type IRRFFaixa = { ate: number; aliquota: number; deduzir: number };

export function calcINSS(base: number, faixas: INSSFaixa[], teto: number): number {
  let total = 0;
  let prev = 0;
  const cappedBase = Math.min(base, teto);
  for (const f of faixas) {
    if (cappedBase <= prev) break;
    const topo = Math.min(cappedBase, f.ate);
    if (topo > prev) total += (topo - prev) * f.aliquota;
    prev = f.ate;
    if (cappedBase <= f.ate) break;
  }
  return +total.toFixed(2);
}

export function calcIRRF(
  baseBruta: number, inss: number, dependentes: number,
  faixas: IRRFFaixa[], deducaoDep: number,
): number {
  const base = Math.max(0, baseBruta - inss - dependentes * deducaoDep);
  for (const f of faixas) {
    if (base <= f.ate) return +Math.max(0, base * f.aliquota - f.deduzir).toFixed(2);
  }
  return 0;
}

export interface PayrollInputs {
  ref_month: Date;
  schedule: { tipo: "fixed_weekly" | "rotative"; config: unknown };
  entries: TimeEntry[];
  salario_base: number;
  carga_horaria_mensal: number;
  // rubricas
  vale_alimentacao_diario?: number;
  vale_transporte_diario?: number;
  desconto_vt_funcionario?: boolean;
  insalubridade_pct?: number;
  periculosidade_pct?: number;
  adicional_noturno?: boolean;
  plano_saude_desconto?: number;
  outros_descontos?: number;
  outros_proventos?: number;
  dependentes_ir?: number;
  desconta_inss?: boolean;
  desconta_irrf?: boolean;
  // config global
  salario_minimo: number;
  teto_inss: number;
  inss_faixas: INSSFaixa[];
  irrf_faixas: IRRFFaixa[];
  deducao_dependente: number;
}

export interface PayrollCalc {
  dias_trabalhados: number;
  horas_previstas: number;
  horas_trabalhadas: number;
  horas_extras_50: number;
  horas_extras_100: number;
  horas_faltantes: number;
  salario_base: number;
  valor_extras: number;
  desconto_faltas: number;
  vale_alimentacao_total: number;
  vale_transporte_total: number;
  desconto_vt: number;
  adicional_insalubridade: number;
  adicional_periculosidade: number;
  adicional_noturno_valor: number;
  inss: number;
  irrf: number;
  fgts: number;
  plano_saude: number;
  outros_proventos: number;
  outros_descontos: number;
  total_proventos: number;
  total_descontos: number;
  salario_final: number;
  salario_minimo_ref: number;
}

export function calcPayrollMonth(args: PayrollInputs): PayrollCalc {
  const {
    ref_month, schedule, entries, salario_base, carga_horaria_mensal,
    vale_alimentacao_diario = 0, vale_transporte_diario = 0,
    desconto_vt_funcionario = true,
    insalubridade_pct = 0, periculosidade_pct = 0,
    adicional_noturno = false,
    plano_saude_desconto = 0, outros_descontos = 0, outros_proventos = 0,
    dependentes_ir = 0, desconta_inss = true, desconta_irrf = true,
    salario_minimo, teto_inss, inss_faixas, irrf_faixas, deducao_dependente,
  } = args;

  const year = ref_month.getFullYear();
  const month = ref_month.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let prevMin = 0, workedMin = 0, ext50Min = 0, ext100Min = 0, nightMin = 0;
  let diasTrabalhados = 0;

  const byDay = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const d = new Date(e.entry_at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(e);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const exp = expectedMinutesForDay(date, schedule as never);
    const dayEntries = byDay.get(`${year}-${month}-${day}`) ?? [];
    const worked = workedMinutesForDay(dayEntries);
    prevMin += exp;
    workedMin += worked;
    if (worked > 0) diasTrabalhados++;
    if (adicional_noturno) nightMin += nightMinutesForDay(dayEntries);

    const isSundayOrHoliday = date.getDay() === 0;
    if (exp === 0) ext100Min += worked;
    else if (worked > exp) {
      const over = worked - exp;
      if (isSundayOrHoliday) ext100Min += over;
      else ext50Min += over;
    }
  }

  const horas_previstas = +(prevMin / 60).toFixed(2);
  const horas_trabalhadas = +(workedMin / 60).toFixed(2);
  const horas_extras_50 = +(ext50Min / 60).toFixed(2);
  const horas_extras_100 = +(ext100Min / 60).toFixed(2);
  const horas_uteis_trab = horas_trabalhadas - horas_extras_50 - horas_extras_100;
  const horas_faltantes = Math.max(0, +(horas_previstas - horas_uteis_trab).toFixed(2));

  const valor_hora = carga_horaria_mensal > 0 ? salario_base / carga_horaria_mensal : 0;
  const valor_extras = +(horas_extras_50 * valor_hora * 1.5 + horas_extras_100 * valor_hora * 2).toFixed(2);
  const desconto_faltas = +(horas_faltantes * valor_hora).toFixed(2);

  const vale_alimentacao_total = +(diasTrabalhados * vale_alimentacao_diario).toFixed(2);
  const vale_transporte_total = +(diasTrabalhados * vale_transporte_diario).toFixed(2);
  const desconto_vt = desconto_vt_funcionario
    ? +Math.min(salario_base * 0.06, vale_transporte_total).toFixed(2)
    : 0;

  const adicional_insalubridade = +(salario_minimo * (insalubridade_pct / 100)).toFixed(2);
  const adicional_periculosidade = +(salario_base * (periculosidade_pct / 100)).toFixed(2);
  const adicional_noturno_valor = adicional_noturno
    ? +((nightMin / 60) * valor_hora * 0.20).toFixed(2)
    : 0;

  // Base para INSS/IRRF: salário + extras + adicionais - faltas (VA e VT não entram)
  const baseInss = Math.max(0,
    salario_base + valor_extras - desconto_faltas
    + adicional_insalubridade + adicional_periculosidade + adicional_noturno_valor
    + outros_proventos);
  const inss = desconta_inss ? calcINSS(baseInss, inss_faixas, teto_inss) : 0;
  const irrf = desconta_irrf ? calcIRRF(baseInss, inss, dependentes_ir, irrf_faixas, deducao_dependente) : 0;
  const fgts = +(baseInss * 0.08).toFixed(2);

  const total_proventos = +(
    salario_base + valor_extras
    + adicional_insalubridade + adicional_periculosidade + adicional_noturno_valor
    + vale_alimentacao_total + vale_transporte_total + outros_proventos
  ).toFixed(2);

  const total_descontos = +(
    desconto_faltas + desconto_vt + inss + irrf + plano_saude_desconto + outros_descontos
  ).toFixed(2);

  const salario_final = +(total_proventos - total_descontos).toFixed(2);

  return {
    dias_trabalhados: diasTrabalhados,
    horas_previstas, horas_trabalhadas, horas_extras_50, horas_extras_100,
    horas_faltantes, salario_base, valor_extras, desconto_faltas,
    vale_alimentacao_total, vale_transporte_total, desconto_vt,
    adicional_insalubridade, adicional_periculosidade, adicional_noturno_valor,
    inss, irrf, fgts,
    plano_saude: plano_saude_desconto,
    outros_proventos, outros_descontos,
    total_proventos, total_descontos, salario_final,
    salario_minimo_ref: salario_minimo,
  };
}
