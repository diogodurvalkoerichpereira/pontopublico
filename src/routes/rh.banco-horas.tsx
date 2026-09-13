import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Hourglass } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
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
  getTimeBank,
  getTimeBankBalances,
  postTimeBankEntry,
} from "@/lib/time-bank.functions";

export const Route = createFileRoute("/rh/banco-horas")({ component: Page });

type LinkRef = {
  id: string;
  registration_number: string | null;
  full_name: string;
};
type Entry = {
  employment_link_id: string;
  registration_number: string | null;
  full_name: string;
  reference_month: string;
  minutes: number;
  balance_after: number;
  note: string | null;
};

// Minutos com sinal -> "+12h30" / "-3h00".
function hm(min: number) {
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  return `${sign}${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, "0")}`;
}

function Page() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getTimeBank);
  const post = useServerFn(postTimeBankEntry);
  const qc = useQueryClient();

  const [linkFilter, setLinkFilter] = useState<string>("todos");
  const [busy, setBusy] = useState(false);
  const [formLink, setFormLink] = useState("");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [minutes, setMinutes] = useState("");

  const loadBalances = useServerFn(getTimeBankBalances);
  const { data } = useQuery({
    queryKey: ["time-bank", activeTenant?.id, linkFilter],
    enabled: !!activeTenant,
    queryFn: () =>
      load({
        data: {
          tenant_id: activeTenant!.id,
          employment_link_id: linkFilter === "todos" ? undefined : linkFilter,
        },
      }),
  });
  const { data: balances } = useQuery({
    queryKey: ["time-bank-balances", activeTenant?.id],
    enabled: !!activeTenant,
    queryFn: () => loadBalances({ data: { tenant_id: activeTenant!.id } }),
  });
  if (!activeTenant) return null;

  const entries = (data?.entries ?? []) as Entry[];
  const links = (data?.links ?? []) as LinkRef[];
  const canManage = data?.canManage ?? false;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["time-bank", activeTenant.id] });
    qc.invalidateQueries({ queryKey: ["time-bank-balances", activeTenant.id] });
  };

  const lancar = async () => {
    if (!formLink) return toast.error("Escolha o servidor");
    const n = Number(minutes);
    if (!Number.isFinite(n) || !Number.isInteger(n))
      return toast.error(
        "Saldo do mês em minutos inteiros (use - para débito)",
      );
    setBusy(true);
    try {
      const r = await post({
        data: {
          tenant_id: activeTenant.id,
          employment_link_id: formLink,
          reference_month: month,
          minutes: n,
        },
      });
      toast.success(`Lançado — acumulado ${hm(r.balance_after)}`);
      setMinutes("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao lançar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <section className="space-y-6">
        <div className="flex items-center gap-3">
          <Hourglass className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Banco de horas
            </h1>
            <p className="text-sm text-muted-foreground">
              Saldo do ponto por competência e o acumulado do servidor. O saldo
              do mês vem da apuração (extras − faltas); o acumulado é
              recalculado a cada lançamento, em ordem de competência.
            </p>
          </div>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-end gap-3 rounded-2xl border bg-card p-4">
            <div className="min-w-56">
              <Label>Servidor</Label>
              <Select value={formLink} onValueChange={setFormLink}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione…" />
                </SelectTrigger>
                <SelectContent>
                  {links.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.full_name}
                      {l.registration_number
                        ? ` (${l.registration_number})`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Competência</Label>
              <Input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
              />
            </div>
            <div className="w-40">
              <Label>Saldo do mês (min)</Label>
              <Input
                type="number"
                step="1"
                placeholder="ex.: 120 ou -30"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
            </div>
            <Button disabled={busy} onClick={lancar}>
              Lançar
            </Button>
          </div>
        )}

        {balances && balances.balances.length > 0 && (
          <div className="rounded-2xl border bg-card p-4 space-y-3">
            <h2 className="font-bold">Posição atual do banco de horas</h2>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">
                  Credores / Devedores
                </div>
                <div className="text-lg font-bold tabular-nums">
                  {balances.totais.credores} / {balances.totais.devedores}
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">
                  A compensar (credor)
                </div>
                <div className="text-lg font-bold tabular-nums text-emerald-600">
                  {hm(balances.totais.saldo_positivo_min)}
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">
                  A repor (devedor)
                </div>
                <div className="text-lg font-bold tabular-nums text-destructive">
                  {hm(balances.totais.saldo_negativo_min)}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {balances.balances.map((b) => (
                <span
                  key={b.employment_link_id}
                  className={`rounded-full border px-3 py-1 text-xs tabular-nums ${
                    b.saldo_minutes < 0
                      ? "text-destructive"
                      : "text-emerald-600"
                  }`}
                >
                  {b.full_name}: {hm(b.saldo_minutes)}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="max-w-xs">
          <Label>Filtrar por servidor</Label>
          <Select value={linkFilter} onValueChange={setLinkFilter}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              {links.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">Servidor</th>
                <th className="p-3">Competência</th>
                <th className="p-3 text-right">Saldo do mês</th>
                <th className="p-3 text-right">Acumulado</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={`${e.employment_link_id}-${e.reference_month}`}
                  className="border-b last:border-0"
                >
                  <td className="p-3 font-medium">{e.full_name}</td>
                  <td className="p-3 tabular-nums">{e.reference_month}</td>
                  <td
                    className={`p-3 text-right tabular-nums ${
                      e.minutes < 0 ? "text-destructive" : "text-emerald-600"
                    }`}
                  >
                    {hm(e.minutes)}
                  </td>
                  <td
                    className={`p-3 text-right font-semibold tabular-nums ${
                      e.balance_after < 0
                        ? "text-destructive"
                        : "text-emerald-600"
                    }`}
                  >
                    {hm(e.balance_after)}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td className="p-4 text-muted-foreground" colSpan={4}>
                    Nenhum lançamento no banco de horas.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
