import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BriefcaseBusiness, Calculator, Play } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import {
  applyTermination,
  calculateTermination,
  getEmploymentSpecialWorkspace,
  processDueEmploymentEvents,
  saveEmploymentSpecialEvent,
} from "@/lib/employment-special.functions";

export const Route = createFileRoute("/rh/eventos-funcionais")({
  component: Page,
});
function Page() {
  return (
    <>
      <Content />
    </>
  );
}
function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getEmploymentSpecialWorkspace);
  const saveEvent = useServerFn(saveEmploymentSpecialEvent);
  const process = useServerFn(processDueEmploymentEvents);
  const calc = useServerFn(calculateTermination);
  const apply = useServerFn(applyTermination);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["employment-special", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const [link, setLink] = useState("");
  const [eventType, setEventType] = useState<
    "reativacao" | "readaptacao" | "progressao" | "reintegracao"
  >("reativacao");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState("");
  const [job, setJob] = useState("");
  const [salary, setSalary] = useState("");
  const [basis, setBasis] = useState("");
  const [worked, setWorked] = useState("30");
  const [months13, setMonths13] = useState("0");
  const [vacMonths, setVacMonths] = useState("0");
  const [notice, setNotice] = useState<
    "trabalhado" | "indenizado" | "dispensado"
  >("dispensado");
  const refresh = () =>
    qc.invalidateQueries({
      queryKey: ["employment-special", activeTenant?.id],
    });
  const fmt = (n: number) =>
    Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  if (!activeTenant) return <p>Selecione uma entidade.</p>;
  const selectedLink = link || data?.links[0]?.id || "";
  const add = async () => {
    try {
      await saveEvent({
        data: {
          tenant_id: activeTenant.id,
          employment_link_id: selectedLink,
          event_type: eventType,
          effective_date: date,
          end_date: end || undefined,
          target_job_title: job || undefined,
          new_base_salary: salary ? Number(salary) : undefined,
          legal_basis: basis,
        },
      });
      await refresh();
      toast.success("Evento agendado");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha");
    }
  };
  const terminate = async () => {
    try {
      await calc({
        data: {
          tenant_id: activeTenant.id,
          employment_link_id: selectedLink,
          termination_date: date,
          reason: "sem_justa_causa",
          notice_type: notice,
          worked_days: Number(worked),
          thirteenth_months: Number(months13),
          vacation_months: Number(vacMonths),
          fgts_balance: 0,
          fgts_penalty_rate: 0.4,
          other_earnings: 0,
          deductions: 0,
        },
      });
      await refresh();
      toast.success("Rescisão calculada");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha");
    }
  };
  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold">
            <BriefcaseBusiness />
            Eventos funcionais e rescisões
          </h1>
          <p className="text-sm text-muted-foreground">
            Readaptação, progressão, reintegração e cálculo rescisório com
            memória.
          </p>
        </div>
        {data?.canManageEvents && (
          <Button
            onClick={async () => {
              const r = await process({ data: { tenant_id: activeTenant.id } });
              await refresh();
              toast.success(`${r.processed} evento(s) aplicado(s)`);
            }}
          >
            <Play className="mr-1 size-4" />
            Processar vencidos
          </Button>
        )}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="rounded-2xl border bg-card p-5">
          <h2 className="mb-4 font-bold">Agendar evento</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Vínculo">
              <select
                className="h-10 rounded-md border px-2"
                value={selectedLink}
                onChange={(e) => setLink(e.target.value)}
              >
                {data?.links.map((l: any) => (
                  <option key={l.id} value={l.id}>
                    {l.registration_number} · {l.full_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tipo">
              <select
                className="h-10 rounded-md border px-2"
                value={eventType}
                onChange={(e) =>
                  setEventType(e.target.value as typeof eventType)
                }
              >
                <option value="reativacao">Reativação</option>
                <option value="readaptacao">Readaptação</option>
                <option value="progressao">Progressão</option>
                <option value="reintegracao">Reintegração</option>
              </select>
            </Field>
            <Field label="Vigência">
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="Fim">
              <Input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
            <Field label="Função temporária">
              <Input value={job} onChange={(e) => setJob(e.target.value)} />
            </Field>
            <Field label="Novo salário">
              <Input
                type="number"
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
              />
            </Field>
            <Field label="Fundamento legal">
              <Input value={basis} onChange={(e) => setBasis(e.target.value)} />
            </Field>
          </div>
          <Button className="mt-4" onClick={add}>
            Agendar
          </Button>
        </div>
        <div className="rounded-2xl border bg-card p-5">
          <h2 className="mb-4 flex items-center gap-2 font-bold">
            <Calculator className="size-4" />
            Calcular rescisão
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Dias trabalhados">
              <Input
                type="number"
                value={worked}
                onChange={(e) => setWorked(e.target.value)}
              />
            </Field>
            <Field label="Avos de 13º">
              <Input
                type="number"
                value={months13}
                onChange={(e) => setMonths13(e.target.value)}
              />
            </Field>
            <Field label="Avos de férias">
              <Input
                type="number"
                value={vacMonths}
                onChange={(e) => setVacMonths(e.target.value)}
              />
            </Field>
            <Field label="Aviso">
              <select
                className="h-10 rounded-md border px-2"
                value={notice}
                onChange={(e) => setNotice(e.target.value as typeof notice)}
              >
                <option value="dispensado">Dispensado</option>
                <option value="trabalhado">Trabalhado</option>
                <option value="indenizado">Indenizado</option>
              </select>
            </Field>
          </div>
          <Button className="mt-4" onClick={terminate}>
            Calcular
          </Button>
        </div>
      </div>
      <div className="rounded-2xl border bg-card p-5">
        <h2 className="mb-3 font-bold">Rescisões calculadas</h2>
        {data?.terminations.map((t: any) => (
          <div
            key={t.id}
            className="flex items-center justify-between border-b py-3"
          >
            <span>
              {t.full_name} · {t.registration_number} · {t.termination_date}
            </span>
            <span className="flex items-center gap-3">
              <b>{fmt(t.net_amount)}</b>
              <Badge>{t.status}</Badge>
              {t.status === "rascunho" && data.canManageTerminations && (
                <Button
                  size="sm"
                  onClick={async () => {
                    await apply({
                      data: {
                        tenant_id: activeTenant.id,
                        termination_id: t.id,
                      },
                    });
                    await refresh();
                  }}
                >
                  Efetivar
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
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
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
