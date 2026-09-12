import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Clock } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { getApuracaoResumoMensal } from "@/lib/time-clock.functions";

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
  const { data, isFetching, error } = useQuery({
    queryKey: ["apuracao-resumo", activeTenant?.id, month],
    enabled: !!activeTenant && /^\d{4}-\d{2}$/.test(month),
    queryFn: () =>
      load({ data: { tenant_id: activeTenant!.id, reference_month: month } }),
  });
  if (!activeTenant) return null;

  const servidores = (data?.servidores ?? []) as Servidor[];
  const totals = data?.totals;

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
                </tr>
              ))}
              {servidores.length === 0 && (
                <tr>
                  <td className="p-4 text-muted-foreground" colSpan={7}>
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
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>
    </AppShell>
  );
}
