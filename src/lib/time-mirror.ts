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
}

export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

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
    days.push({
      date,
      punches: dayPunches,
      intervals,
      workedMinutes,
      openInterval: dayPunches.length % 2 === 1,
    });
  }
  return { days, totalMinutes };
}
