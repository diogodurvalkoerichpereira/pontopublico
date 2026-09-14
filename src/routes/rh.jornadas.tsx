import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarRange } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import {
  getEmploymentWeeklySchedules,
  saveEmploymentWeeklySchedule,
} from "@/lib/work-schedule.functions";

export const Route = createFileRoute("/rh/jornadas")({ component: Page });

type Servidor = {
  employment_link_id: string;
  registration_number: string | null;
  full_name: string;
  weekly_hours: number;
  custom: boolean;
  minutes: number[]; // [dom..sab]
};

const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function hm(min: number) {
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

function Page() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getEmploymentWeeklySchedules);
  const save = useServerFn(saveEmploymentWeeklySchedule);
  const qc = useQueryClient();

  const [sel, setSel] = useState("");
  const [minutes, setMinutes] = useState<string[]>(Array(7).fill("0"));
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ["weekly-schedules", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });

  const servidores = (data?.servidores ?? []) as Servidor[];
  const canManage = data?.canManage ?? false;
  const selected = servidores.find((s) => s.employment_link_id === sel);

  // Ao escolher um servidor, pré-preenche os 7 campos com a escala efetiva atual.
  useEffect(() => {
    if (selected) setMinutes(selected.minutes.map((m) => String(m)));
  }, [selected]);

  if (!activeTenant) return null;

  const total = minutes.reduce((acc, m) => acc + (Number(m) || 0), 0);

  const salvar = async () => {
    if (!sel) return toast.error("Escolha o servidor");
    const parsed = minutes.map((m) => Number(m));
    if (parsed.some((m) => !Number.isInteger(m) || m < 0 || m > 1440))
      return toast.error("Minutos por dia entre 0 e 1440");
    setBusy(true);
    try {
      await save({
        data: {
          tenant_id: activeTenant.id,
          employment_link_id: sel,
          minutes: parsed,
        },
      });
      toast.success("Escala salva");
      qc.invalidateQueries({ queryKey: ["weekly-schedules", activeTenant.id] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="space-y-6">
        <div className="flex items-center gap-3">
          <CalendarRange className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Jornadas semanais
            </h1>
            <p className="text-sm text-muted-foreground">
              Minutos previstos por dia da semana, por servidor. A apuração de
              ponto usa esta escala; sem escala, distribui a jornada semanal de
              seg a sex.
            </p>
          </div>
        </div>

        {canManage && (
          <div className="space-y-3 rounded-2xl border bg-card p-4">
            <div className="max-w-md">
              <Label>Servidor</Label>
              <Select value={sel} onValueChange={setSel}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione…" />
                </SelectTrigger>
                <SelectContent>
                  {servidores.map((s) => (
                    <SelectItem
                      key={s.employment_link_id}
                      value={s.employment_link_id}
                    >
                      {s.full_name}
                      {s.registration_number
                        ? ` (${s.registration_number})`
                        : ""}
                      {s.custom ? " · escala própria" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {sel && (
              <>
                <div className="grid grid-cols-4 gap-3 sm:grid-cols-7">
                  {DIAS.map((dia, i) => (
                    <div key={dia}>
                      <Label className="text-xs">{dia}</Label>
                      <Input
                        type="number"
                        step="1"
                        min={0}
                        max={1440}
                        value={minutes[i]}
                        onChange={(e) =>
                          setMinutes((cur) =>
                            cur.map((v, j) => (j === i ? e.target.value : v)),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-4">
                  <Button disabled={busy} onClick={salvar}>
                    Salvar escala
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Total semanal: <strong>{hm(total)}</strong>
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        <div className="overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">Servidor</th>
                {DIAS.map((d) => (
                  <th key={d} className="p-3 text-right">
                    {d}
                  </th>
                ))}
                <th className="p-3 text-right">Semana</th>
              </tr>
            </thead>
            <tbody>
              {servidores.map((s) => (
                <tr
                  key={s.employment_link_id}
                  className="border-b last:border-0"
                >
                  <td className="p-3 font-medium">
                    {s.full_name}
                    {s.custom ? "" : " (padrão)"}
                  </td>
                  {s.minutes.map((m, i) => (
                    <td
                      key={i}
                      className="p-3 text-right tabular-nums text-muted-foreground"
                    >
                      {m ? hm(m) : "—"}
                    </td>
                  ))}
                  <td className="p-3 text-right font-semibold tabular-nums">
                    {hm(s.minutes.reduce((a, m) => a + m, 0))}
                  </td>
                </tr>
              ))}
              {servidores.length === 0 && (
                <tr>
                  <td className="p-4 text-muted-foreground" colSpan={9}>
                    Nenhum servidor ativo.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
