import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Palmtree } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import {
  generateVacationPeriod,
  getVacationWorkspace,
  scheduleVacation,
  cancelVacation,
  getVacationDeadlineAlerts,
} from "@/lib/vacation.functions";
type VacationAlert = {
  id: string;
  full_name: string;
  registration_number: string;
  accrual_start: string;
  accrual_end: string;
  concession_deadline: string;
  dias_para_limite: number;
  vencido: boolean;
};

export const Route = createFileRoute("/rh/ferias")({ component: Page });
function Page() {
  const { activeTenant } = useAuth(),
    load = useServerFn(getVacationWorkspace),
    gen = useServerFn(generateVacationPeriod),
    schedule = useServerFn(scheduleVacation),
    cancel = useServerFn(cancelVacation),
    loadAlerts = useServerFn(getVacationDeadlineAlerts),
    qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["vacations", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: alerts } = useQuery({
    queryKey: ["vacation-alerts", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () =>
      loadAlerts({
        data: {
          tenant_id: activeTenant!.id,
          data_referencia: new Date().toISOString().slice(0, 10),
          dias_alerta: 60,
        },
      }),
  });
  const [link, setLink] = useState(""),
    [start, setStart] = useState(new Date().toISOString().slice(0, 10)),
    [period, setPeriod] = useState(""),
    [days, setDays] = useState("30");
  if (!activeTenant) return null;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["vacations", activeTenant.id] });
    qc.invalidateQueries({ queryKey: ["vacation-alerts", activeTenant.id] });
  };
  return (
    <>
      <section className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold">
            <Palmtree />
            Gestão de férias
          </h1>
          <p className="text-sm text-muted-foreground">
            Períodos, fracionamento, saldo, pagamento antecipado e dashboard.
          </p>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border bg-card p-5">
            <h2 className="mb-3 font-bold">Gerar período aquisitivo</h2>
            <Field label="Vínculo">
              <select
                className="h-10 w-full rounded-md border px-2"
                value={link || data?.links[0]?.id || ""}
                onChange={(e) => setLink(e.target.value)}
              >
                {data?.links.map((l: any) => (
                  <option key={l.id} value={l.id}>
                    {l.registration_number} · {l.full_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Início">
              <Input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Button
              className="mt-3"
              onClick={async () => {
                await gen({
                  data: {
                    tenant_id: activeTenant.id,
                    employment_link_id: link || data!.links[0].id,
                    accrual_start: start,
                  },
                });
                await refresh();
                toast.success("Período gerado");
              }}
            >
              Gerar
            </Button>
          </div>
          <div className="rounded-2xl border bg-card p-5">
            <h2 className="mb-3 font-bold">Programar fração</h2>
            <Field label="Período">
              <select
                className="h-10 w-full rounded-md border px-2"
                value={period || data?.periods[0]?.id || ""}
                onChange={(e) => setPeriod(e.target.value)}
              >
                {data?.periods.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.registration_number} · {p.accrual_start} —{" "}
                    {p.accrual_end}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Início">
              <Input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="Dias">
              <Input
                type="number"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </Field>
            <Button
              className="mt-3"
              onClick={async () => {
                const r = await schedule({
                  data: {
                    tenant_id: activeTenant.id,
                    accrual_period_id: period || data!.periods[0].id,
                    start_date: start,
                    days: Number(days),
                  },
                });
                await refresh();
                toast.success(`Férias programadas: R$ ${r.total}`);
              }}
            >
              Programar
            </Button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          {["disponivel", "programado", "em_gozo", "vencido"].map((status) => (
            <div className="rounded-xl border bg-card p-4" key={status}>
              <p className="text-xs uppercase text-muted-foreground">
                {status}
              </p>
              <b className="text-2xl">
                {data?.periods.filter((p: any) => p.status === status).length ||
                  0}
              </b>
            </div>
          ))}
        </div>
        {alerts && alerts.alerts.length > 0 && (
          <div className="rounded-2xl border bg-card p-5">
            <h2 className="mb-1 font-bold">
              Limite do período concessivo (CLT art. 137)
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">
              {alerts.vencidos} vencido(s) · {alerts.aVencer} a vencer em{" "}
              {alerts.dias} dias. Período vencido gera pagamento em dobro.
            </p>
            {alerts.alerts.map((a: VacationAlert) => (
              <div
                key={a.id}
                className="flex flex-wrap justify-between gap-2 border-b py-2 text-sm"
              >
                <span>
                  {a.registration_number} · {a.full_name} — período{" "}
                  {a.accrual_start} a {a.accrual_end}
                </span>
                <b className={a.vencido ? "text-destructive" : "text-primary"}>
                  {a.vencido
                    ? `vencido há ${-a.dias_para_limite} dias`
                    : `vence em ${a.dias_para_limite} dias`}{" "}
                  ({a.concession_deadline})
                </b>
              </div>
            ))}
          </div>
        )}
        <div className="rounded-2xl border bg-card p-5">
          <h2 className="mb-3 font-bold">Frações programadas</h2>
          {data?.schedules.map((s: any) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b py-3"
            >
              <span>
                {s.start_date} — {s.end_date} · {s.days} dias
                <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">
                  {s.status}
                </span>
              </span>
              <div className="flex items-center gap-3">
                <b>R$ {Number(s.total_amount).toFixed(2)}</b>
                {(s.status === "programado" || s.status === "aprovado") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      if (!window.confirm("Cancelar esta fração de férias?"))
                        return;
                      try {
                        await cancel({
                          data: {
                            tenant_id: activeTenant.id,
                            schedule_id: s.id,
                            motivo: "Cancelado pela gestão",
                          },
                        });
                        await refresh();
                        toast.success("Fração cancelada — saldo liberado");
                      } catch (error) {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : "Falha ao cancelar",
                        );
                      }
                    }}
                  >
                    Cancelar
                  </Button>
                )}
              </div>
            </div>
          ))}
          {data?.schedules.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nenhuma fração programada.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
