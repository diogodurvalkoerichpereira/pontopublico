// Espelho de ponto (O1-03c): apuracao pura da jornada a partir das marcacoes
// encadeadas (time_clock_punches). Sem I/O — recebe as marcacoes ja lidas e
// devolve, por dia, os intervalos pareados e os minutos trabalhados.
//
// As marcacoes NAO tem tipo (entrada/saida): o pareamento e POSICIONAL — na ordem
// do NSR, a 1a marca do dia e entrada, a 2a saida, a 3a entrada, e assim por
// diante. Dia com numero impar de marcas fica com um intervalo aberto (openInterval).
// Tolerancia legal, feriados e banco de horas sao refinamentos do O1-03d.

export interface MirrorPunch {
  nsr: number;
  punchTime: string; // ISO 8601
  recordHash: string;
  source: string;
}

export interface MirrorInterval {
  in: string;
  out: string;
  minutes: number;
}

export interface MirrorDay {
  date: string; // YYYY-MM-DD no fuso do ente
  punches: MirrorPunch[];
  intervals: MirrorInterval[];
  workedMinutes: number;
  openInterval: boolean;
  isHoliday: boolean;
  holidayName: string | null;
}

/** Regra de feriado: `year` nulo recorre todo ano; senao vale só naquele ano. */
export interface HolidayRule {
  year: number | null;
  month: number;
  day: number;
  name: string;
}

export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

/** Nome do feriado que casa com a data `YYYY-MM-DD`, ou null. */
function matchHoliday(date: string, holidays: HolidayRule[]): string | null {
  const [year, month, day] = date.split("-").map(Number);
  const hit = holidays.find(
    (h) =>
      h.month === month && h.day === day && (h.year == null || h.year === year),
  );
  return hit ? hit.name : null;
}

/** Dia-calendario local (no fuso do ente) de uma marcacao — estavel por fuso. */
function localDayKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function buildTimeMirror(
  punches: MirrorPunch[],
  timeZone: string = DEFAULT_TIME_ZONE,
  holidays: HolidayRule[] = [],
): { days: MirrorDay[]; totalMinutes: number } {
  const byDay = new Map<string, MirrorPunch[]>();
  for (const punch of [...punches].sort((a, b) => a.nsr - b.nsr)) {
    const key = localDayKey(punch.punchTime, timeZone);
    const list = byDay.get(key);
    if (list) list.push(punch);
    else byDay.set(key, [punch]);
  }

  const days: MirrorDay[] = [];
  let totalMinutes = 0;
  for (const [date, dayPunches] of [...byDay.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    const intervals: MirrorInterval[] = [];
    let workedMinutes = 0;
    for (let i = 0; i + 1 < dayPunches.length; i += 2) {
      const start = dayPunches[i];
      const end = dayPunches[i + 1];
      const minutes = Math.round(
        (new Date(end.punchTime).getTime() -
          new Date(start.punchTime).getTime()) /
          60000,
      );
      intervals.push({ in: start.punchTime, out: end.punchTime, minutes });
      workedMinutes += minutes;
    }
    totalMinutes += workedMinutes;
    const holidayName = matchHoliday(date, holidays);
    days.push({
      date,
      punches: dayPunches,
      intervals,
      workedMinutes,
      openInterval: dayPunches.length % 2 === 1,
      isHoliday: holidayName !== null,
      holidayName,
    });
  }
  return { days, totalMinutes };
}

// --- Apuração de jornada (O1-03e): previsto × trabalhado, tolerância, extras/faltas.

export interface ApuracaoConfig {
  /** Minutos previstos por dia da semana (índice 0=domingo … 6=sábado). */
  expectedMinutesByWeekday: number[];
  /** Tolerância legal por dia (CLT art. 58 §1). Desvio até aqui é desconsiderado. */
  toleranceMinutesPerDay: number;
  /**
   * Escala rotativa (ciclo de N dias, O1-03f parte 3): quando presente, tem
   * PRECEDÊNCIA sobre `expectedMinutesByWeekday` — o previsto do dia vem do ciclo,
   * não do dia da semana (turno em ciclo não repete por semana calendário).
   */
  rotatingSchedule?: RotatingScheduleRow;
}

export interface ApuracaoDay {
  date: string;
  weekday: number;
  expectedMinutes: number;
  workedMinutes: number;
  isHoliday: boolean;
  withinTolerance: boolean;
  extraMinutes: number;
  faltaMinutes: number;
}

export interface ApuracaoResult {
  days: ApuracaoDay[];
  totals: {
    expectedMinutes: number;
    workedMinutes: number;
    extraMinutes: number;
    faltaMinutes: number;
  };
}

/** Dia da semana (0=domingo) do dia-calendario `YYYY-MM-DD`. */
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * Apura a jornada a partir dos dias do espelho e da config de previsto. Feriado
 * tem previsto 0 (todo trabalho no feriado é extra). O desvio dentro da tolerância
 * legal é desconsiderado (nem extra nem falta); acima dela, o desvio inteiro conta.
 */
export function apurarJornada(
  days: MirrorDay[],
  config: ApuracaoConfig,
): ApuracaoResult {
  const out: ApuracaoDay[] = [];
  const totals = {
    expectedMinutes: 0,
    workedMinutes: 0,
    extraMinutes: 0,
    faltaMinutes: 0,
  };
  for (const day of days) {
    const weekday = weekdayOf(day.date);
    const expectedMinutes = day.isHoliday
      ? 0
      : config.rotatingSchedule
        ? expectedMinutesForRotating(config.rotatingSchedule, day.date)
        : (config.expectedMinutesByWeekday[weekday] ?? 0);
    const deviation = day.workedMinutes - expectedMinutes;
    const withinTolerance =
      Math.abs(deviation) <= config.toleranceMinutesPerDay;
    const extraMinutes = withinTolerance ? 0 : Math.max(0, deviation);
    const faltaMinutes = withinTolerance ? 0 : Math.max(0, -deviation);
    out.push({
      date: day.date,
      weekday,
      expectedMinutes,
      workedMinutes: day.workedMinutes,
      isHoliday: day.isHoliday,
      withinTolerance,
      extraMinutes,
      faltaMinutes,
    });
    totals.expectedMinutes += expectedMinutes;
    totals.workedMinutes += day.workedMinutes;
    totals.extraMinutes += extraMinutes;
    totals.faltaMinutes += faltaMinutes;
  }
  return { days: out, totals };
}

/**
 * Config de previsto padrão a partir da jornada semanal: distribui as horas de
 * seg-sex igualmente, sábado/domingo 0. É o fallback quando o vínculo não tem
 * escala semanal customizada (O1-03f).
 */
export function defaultExpectedByWeekday(weeklyHours: number): number[] {
  const perWorkday = Math.round((weeklyHours * 60) / 5);
  return [0, perWorkday, perWorkday, perWorkday, perWorkday, perWorkday, 0];
}

/** Escala semanal customizada (minutos previstos por dia, domingo..sábado). */
export interface WeeklyScheduleRow {
  minutes_sun: number;
  minutes_mon: number;
  minutes_tue: number;
  minutes_wed: number;
  minutes_thu: number;
  minutes_fri: number;
  minutes_sat: number;
}

/**
 * Minutos previstos por dia da semana (índice 0=domingo … 6=sábado) a partir da
 * escala customizada do vínculo (O1-03f); sem escala, cai no padrão por
 * `weekly_hours` (seg-sex). Fonte única usada pela apuração e pelo resumo.
 */
export function expectedByWeekdayFor(
  schedule: WeeklyScheduleRow | null | undefined,
  fallbackWeeklyHours: number,
): number[] {
  if (!schedule) return defaultExpectedByWeekday(fallbackWeeklyHours);
  return [
    Number(schedule.minutes_sun),
    Number(schedule.minutes_mon),
    Number(schedule.minutes_tue),
    Number(schedule.minutes_wed),
    Number(schedule.minutes_thu),
    Number(schedule.minutes_fri),
    Number(schedule.minutes_sat),
  ];
}

/**
 * Escala rotativa (ciclo de N dias, O1-03f parte 3): `cycle_start_date` ancora o
 * dia 0 do ciclo; `minutes_by_day[i]` é o previsto do i-ésimo dia do ciclo. Serve
 * turno que não repete por semana calendário (ex.: 12x36 = ciclo de 2 dias).
 */
export interface RotatingScheduleRow {
  cycle_start_date: string; // YYYY-MM-DD
  minutes_by_day: number[];
}

/** Dia-calendário (UTC, meia-noite) do dia `YYYY-MM-DD`, em dias desde a época. */
function dayNumber(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 86_400_000);
}

/**
 * Previsto (minutos) do dia `date` pela escala rotativa: a distância em dias
 * desde `cycle_start_date`, módulo o comprimento do ciclo, indexa `minutes_by_day`.
 * Data anterior à âncora funciona igual (módulo sempre não-negativo) — o ciclo é
 * infinito nos dois sentidos a partir da âncora.
 */
export function expectedMinutesForRotating(
  schedule: RotatingScheduleRow,
  date: string,
): number {
  const n = schedule.minutes_by_day.length;
  if (n === 0) return 0;
  const diff = dayNumber(date) - dayNumber(schedule.cycle_start_date);
  const idx = ((diff % n) + n) % n;
  return Number(schedule.minutes_by_day[idx] ?? 0);
}
