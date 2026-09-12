import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Clock } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import {
  getApuracaoResumoMensal,
  getPunchInconsistencies,
  postTimeBankFromApuracao,
} from "@/lib/time-clock.functions";

export const Route = createFileRoute("/rh/apuracao")({ component: Page });

type Servidor = {
  employment_link_id: string;
  registration_number: string | null;
  full_name: string;
  expectedMinutes: number;
  workedMinutes: number;
  extraMinutes: number;
  faltaMinutes: number;
  saldoMinutes: number;
};

type Inconsistencia = {
  employment_link_id: string;
  registration_number: string | null;
  full_name: string;
  date: string;
  punchCount: number;
};

// Minutos -> "12h30" (com sinal para o saldo).
function hm(min: number, signed = false) {
  const sign = min < 0 ? "-" : signed && min > 0 ? "+" : "";
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}h${String(m).padStart(2, "0")}`;
}

function Page() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getApuracaoResumoMensal);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const loadInc = useServerFn(getPunchInconsistencies);
  const monthOk = /^\d{4}-\d{2}$/.test(month);
  const { data, isFetching, error } = useQuery({
    queryKey: ["apuracao-resumo", activeTenant?.id, month],
    enabled: !!activeTenant && monthOk,
    queryFn: () =>
      load({ data: { tenant_id: activeTenant!.id, reference_month: month } }),
  });
  const { data: incData } = useQuery({
    queryKey: ["apuracao-inconsistencias", activeTenant?.id, month],
    enabled: !!activeTenant && monthOk,
    queryFn: () =>
      loadInc({
        data: { tenant_id: activeTenant!.id, reference_month: month },
      }),
  });
  const bank = useServerFn(postTimeBankFromApuracao);
  const [posting, setPosting] = useState<string | null>(null);
  if (!activeTenant) return null;

  const servidores = (data?.servidores ?? []) as Servidor[];
  const totals = data?.totals;
  const canManage = data?.canManage ?? false;
  const inconsistencias = (incData?.inconsistencias ?? []) as Inconsistencia[];

  const lancarBanco = async (linkId: string) => {
    setPosting(linkId);
    try {
      const r = await bank({
        data: {
          tenant_id: activeTenant.id,
          employment_link_id: linkId,
          reference_month: month,
        },
      });
      toast.success(
        `Lançado no banco de horas — acumulado ${hm(r.balance_after, true)}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao lançar");
    } finally {
      setPosting(null);
    }
  };

  return (
    <AppShell>
      <section className="space-y-6">
        <div className="flex items-center gap-3">
          <Clock className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Apuração de ponto — resumo mensal
            </h1>
            <p className="text-sm text-muted-foreground">
              Previsto × trabalhado, extras, faltas e saldo por servidor ativo,
              no mês. Só os dias com marcação entram na apuração; ordenado pelo
              menor saldo (maior falta) primeiro.
            </p>
          </div>
        </div>

        <div className="max-w-xs">
          <Label>Competência</Label>
          <Input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>

        {error && (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Falha ao carregar"}
          </p>
        )}

        {inconsistencias.length > 0 && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="size-4" />
              Marcações inconsistentes ({inconsistencias.length}) — corrija
              antes de valorar
            </div>
            <p className="mt-1 text-sm">
              Dias com número ímpar de marcações têm intervalo em aberto; a
              apuração descarta a marca solta e pode gerar falta indevida. A
              correção é por <strong>nova marcação</strong> (o ponto é
              imutável).
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {inconsistencias.map((i) => (
                <li key={`${i.employment_link_id}-${i.date}`}>
                  <span className="font-medium">{i.full_name}</span>
                  {i.registration_number
                    ? ` (${i.registration_number})`
                    : ""} — {i.date} · {i.punchCount} marcações
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">Servidor</th>
                <th className="p-3">Matrícula</th>
                <th className="p-3 text-right">Previsto</th>
                <th className="p-3 text-right">Trabalhado</th>
                <th className="p-3 text-right">Extras</th>
                <th className="p-3 text-right">Faltas</th>
                <th className="p-3 text-right">Saldo</th>
                {canManage && <th className="p-3" />}
              </tr>
            </thead>
            <tbody>
              {servidores.map((s) => (
                <tr
                  key={s.employment_link_id}
                  className="border-b last:border-0"
                >
                  <td className="p-3 font-medium">{s.full_name}</td>
                  <td className="p-3 text-muted-foreground">
                    {s.registration_number ?? "—"}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {hm(s.expectedMinutes)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {hm(s.workedMinutes)}
                  </td>
                  <td className="p-3 text-right tabular-nums text-emerald-600">
                    {s.extraMinutes ? hm(s.extraMinutes) : "—"}
                  </td>
                  <td className="p-3 text-right tabular-nums text-destructive">
                    {s.faltaMinutes ? hm(s.faltaMinutes) : "—"}
                  </td>
                  <td
                    className={`p-3 text-right font-semibold tabular-nums ${
                      s.saldoMinutes < 0
                        ? "text-destructive"
                        : s.saldoMinutes > 0
                          ? "text-emerald-600"
                          : ""
                    }`}
                  >
                    {hm(s.saldoMinutes, true)}
                  </td>
                  {canManage && (
                    <td className="p-3 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={posting === s.employment_link_id}
                        onClick={() => lancarBanco(s.employment_link_id)}
                        title="Lança o saldo apurado deste mês no banco de horas"
                      >
                        Lançar no banco
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
              {servidores.length === 0 && (
                <tr>
                  <td
                    className="p-4 text-muted-foreground"
                    colSpan={canManage ? 8 : 7}
                  >
                    {isFetching
                      ? "Carregando…"
                      : "Nenhum servidor ativo na competência."}
                  </td>
                </tr>
              )}
            </tbody>
            {totals && servidores.length > 0 && (
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="p-3" colSpan={2}>
                    Total ({servidores.length})
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {hm(totals.expectedMinutes)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {hm(totals.workedMinutes)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {hm(totals.extraMinutes)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {hm(totals.faltaMinutes)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {hm(totals.saldoMinutes, true)}
                  </td>
                  {canManage && <td className="p-3" />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>
    </AppShell>
  );
}
