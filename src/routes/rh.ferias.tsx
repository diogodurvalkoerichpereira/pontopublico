import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Palmtree } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import {
  generateVacationPeriod,
  getVacationWorkspace,
  scheduleVacation,
} from "@/lib/vacation.functions";
export const Route = createFileRoute("/rh/ferias")({ component: Page });
function Page() {
  const { activeTenant } = useAuth(),
    load = useServerFn(getVacationWorkspace),
    gen = useServerFn(generateVacationPeriod),
    schedule = useServerFn(scheduleVacation),
    qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["vacations", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const [link, setLink] = useState(""),
    [start, setStart] = useState(new Date().toISOString().slice(0, 10)),
    [period, setPeriod] = useState(""),
    [days, setDays] = useState("30");
  if (!activeTenant) return null;
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["vacations", activeTenant.id] });
  return (
    <AppShell>
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
        <div className="rounded-2xl border bg-card p-5">
          {data?.schedules.map((s: any) => (
            <div key={s.id} className="flex justify-between border-b py-3">
              <span>
                {s.start_date} — {s.end_date} · {s.days} dias
              </span>
              <b>R$ {Number(s.total_amount).toFixed(2)}</b>
            </div>
          ))}
        </div>
      </section>
    </AppShell>
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
