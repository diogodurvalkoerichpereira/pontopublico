import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Fingerprint, Plus, ShieldCheck, CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  recordTimeClockPunch,
  getTimeClockPunches,
  verifyTimeClockChain,
  getTimeMirror,
  getPunchReceipt,
  getTimeApuracao,
  depositTimeApuracao,
  getApuracaoResumoMensal,
} from "@/lib/time-clock.functions";
import { getHolidays, saveHoliday } from "@/lib/holidays.functions";
import { getPayrollCatalog } from "@/lib/payroll-catalog.functions";

export const Route = createFileRoute("/rh/ponto")({ component: Page });

type Servidor = {
  employment_link_id: string;
  registration_number: string | null;
  full_name: string;
};
type Punch = {
  id: string;
  employment_link_id: string;
  nsr: number;
  punch_time: string;
  source: string;
  record_hash: string;
};
type Receipt = {
  nsr: number;
  punch_time: string;
  source: string;
  record_hash: string;
  verification_code: string;
  employee: {
    registration_number: string;
    full_name: string;
    cpf: string | null;
    unit_name: string | null;
  };
};

// Minutos -> "12h30" (com sinal quando pedido).
function hm(min: number, signed = false) {
  const sign = min < 0 ? "-" : signed && min > 0 ? "+" : "";
  const abs = Math.abs(min);
  return `${sign}${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, "0")}`;
}
const dataHora = (iso: string) => new Date(iso).toLocaleString("pt-BR");
const brl = (v: number) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const mesDe = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return {
    from: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    to: new Date(Date.UTC(y, m, 1) - 1).toISOString(),
  };
};

function Page() {
  const { activeTenant } = useAuth();
  const qc = useQueryClient();

  const registrar = useServerFn(recordTimeClockPunch);
  const loadPunches = useServerFn(getTimeClockPunches);
  const verificar = useServerFn(verifyTimeClockChain);
  const loadMirror = useServerFn(getTimeMirror);
  const loadReceipt = useServerFn(getPunchReceipt);
  const loadApuracao = useServerFn(getTimeApuracao);
  const depositar = useServerFn(depositTimeApuracao);
  const loadServidores = useServerFn(getApuracaoResumoMensal);
  const loadHolidays = useServerFn(getHolidays);
  const gravarFeriado = useServerFn(saveHoliday);
  const loadRubrics = useServerFn(getPayrollCatalog);

  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [linkId, setLinkId] = useState("");
  const [busy, setBusy] = useState(false);

  const [punchOpen, setPunchOpen] = useState(false);
  const [punchTime, setPunchTime] = useState("");
  const [punchSource, setPunchSource] = useState("manual");

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [cadeia, setCadeia] = useState<{
    valid: boolean;
    brokenAtNsr?: number | null;
  } | null>(null);

  const [depositOpen, setDepositOpen] = useState(false);
  const [depForm, setDepForm] = useState({
    overtime_rubric_id: "",
    absence_rubric_id: "",
    overtime_multiplier: "1.5",
    monthly_base_hours: "220",
    tolerance_minutes: "10",
  });

  const [feriadoOpen, setFeriadoOpen] = useState(false);
  const [feriado, setFeriado] = useState({
    name: "",
    holiday_type: "municipal",
    year: "",
    month: String(new Date().getMonth() + 1),
    day: "1",
  });

  const monthOk = /^\d{4}-\d{2}$/.test(month);
  const periodo = monthOk ? mesDe(month) : null;

  const { data: resumo } = useQuery({
    queryKey: ["ponto-servidores", activeTenant?.id, month],
    enabled: Boolean(activeTenant) && monthOk,
    queryFn: () =>
      loadServidores({
        data: { tenant_id: activeTenant!.id, reference_month: month },
      }),
  });
  const servidores = (resumo?.servidores ?? []) as Servidor[];
  const canManage = resumo?.canManage ?? false;

  const { data: punches } = useQuery({
    queryKey: ["ponto-punches", activeTenant?.id, linkId, month],
    enabled: Boolean(activeTenant && linkId && periodo),
    queryFn: () =>
      loadPunches({
        data: {
          tenant_id: activeTenant!.id,
          employment_link_id: linkId,
          from: periodo!.from,
          to: periodo!.to,
        },
      }),
  });
  const { data: mirror } = useQuery({
    queryKey: ["ponto-espelho", activeTenant?.id, linkId, month],
    enabled: Boolean(activeTenant && linkId && periodo),
    queryFn: () =>
      loadMirror({
        data: {
          tenant_id: activeTenant!.id,
          employment_link_id: linkId,
          from: periodo!.from,
          to: periodo!.to,
        },
      }),
  });
  const { data: apuracao } = useQuery({
    queryKey: ["ponto-apuracao", activeTenant?.id, linkId, month],
    enabled: Boolean(activeTenant && linkId && periodo),
    queryFn: () =>
      loadApuracao({
        data: {
          tenant_id: activeTenant!.id,
          employment_link_id: linkId,
          from: periodo!.from,
          to: periodo!.to,
        },
      }),
  });
  const { data: holidays } = useQuery({
    queryKey: ["ponto-feriados", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadHolidays({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: rubrics } = useQuery({
    queryKey: ["ponto-rubricas", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadRubrics({ data: { tenant_id: activeTenant!.id } }),
  });

  const refreshPonto = () => {
    qc.invalidateQueries({ queryKey: ["ponto-punches", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["ponto-espelho", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["ponto-apuracao", activeTenant?.id] });
  };

  if (!activeTenant) return null;

  const submitPunch = async () => {
    if (!linkId) return;
    setBusy(true);
    try {
      const r = await registrar({
        data: {
          tenant_id: activeTenant.id,
          employment_link_id: linkId,
          punch_time: punchTime
            ? new Date(punchTime).toISOString()
            : new Date().toISOString(),
          source: punchSource as "manual" | "app" | "rep",
        },
      });
      toast.success(
        `Marcação registrada — NSR ${r.nsr}, hash ${r.recordHash.slice(0, 12)}…`,
      );
      setPunchOpen(false);
      setPunchTime("");
      refreshPonto();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao registrar",
      );
    } finally {
      setBusy(false);
    }
  };

  const verificarCadeia = async () => {
    setBusy(true);
    try {
      const r = await verificar({ data: { tenant_id: activeTenant.id } });
      setCadeia(r);
      if (r.valid) toast.success("Cadeia íntegra: nenhuma marcação adulterada");
      else toast.error(`Cadeia quebrada a partir do NSR ${r.brokenAtNsr}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao verificar",
      );
    } finally {
      setBusy(false);
    }
  };

  const abrirComprovante = async (punchId: string) => {
    try {
      const r = await loadReceipt({
        data: { tenant_id: activeTenant.id, punch_id: punchId },
      });
      setReceipt(r as Receipt);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao emitir");
    }
  };

  const submitDeposit = async () => {
    if (!linkId) return;
    setBusy(true);
    try {
      const r = await depositar({
        data: {
          tenant_id: activeTenant.id,
          employment_link_id: linkId,
          reference_month: month,
          overtime_rubric_id: depForm.overtime_rubric_id || undefined,
          absence_rubric_id: depForm.absence_rubric_id || undefined,
          overtime_multiplier: Number(depForm.overtime_multiplier),
          monthly_base_hours: Number(depForm.monthly_base_hours),
          tolerance_minutes: Number(depForm.tolerance_minutes),
        },
      });
      toast.success(
        `Depositado na folha de ${month}: ${hm(r.extraMinutes)} de extras ` +
          `(${brl(r.overtimeAmount)}) e ${hm(r.faltaMinutes)} de faltas ` +
          `(${brl(r.absenceAmount)})`,
      );
      setDepositOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao depositar",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitFeriado = async () => {
    setBusy(true);
    try {
      await gravarFeriado({
        data: {
          tenant_id: activeTenant.id,
          name: feriado.name.trim(),
          holiday_type: feriado.holiday_type as
            "estadual" | "municipal" | "facultativo",
          year: feriado.year ? Number(feriado.year) : null,
          month: Number(feriado.month),
          day: Number(feriado.day),
        },
      });
      toast.success("Feriado gravado");
      setFeriadoOpen(false);
      setFeriado((f) => ({ ...f, name: "" }));
      qc.invalidateQueries({
        queryKey: ["ponto-feriados", activeTenant.id],
      });
      refreshPonto();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao gravar");
    } finally {
      setBusy(false);
    }
  };

  const lista = (punches ?? []) as Punch[];
  const rubricList = ((rubrics as { rubrics?: unknown })?.rubrics ??
    []) as Array<{
    id: string;
    code: string;
    name: string;
    status: string;
  }>;

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Fingerprint className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Ponto — registro probatório
            </h1>
            <p className="text-sm text-muted-foreground">
              Marcações imutáveis, numeradas por NSR e encadeadas por SHA-256:
              alterar uma quebra a cadeia e a verificação acusa.
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={verificarCadeia} disabled={busy}>
          <ShieldCheck className="size-4" /> Verificar cadeia
        </Button>
      </div>

      <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
        Base <strong>interna</strong> de prova. O <strong>AFD/AEJ</strong> da
        Portaria MTP 671/2021 e o comprovante oficial ao trabalhador dependem de
        homologação por ferramenta oficial e ainda não existem aqui — o
        comprovante abaixo é interno.
      </div>

      {cadeia && (
        <div
          className={`rounded-xl border p-3 text-sm ${cadeia.valid ? "bg-emerald-50 border-emerald-300" : "bg-red-50 border-red-300"}`}
        >
          {cadeia.valid ? (
            <>
              <strong>Cadeia íntegra.</strong> Cada marcação confere com o hash
              da anterior — nenhuma foi inserida ou alterada a posteriori.
            </>
          ) : (
            <>
              <strong>Cadeia quebrada no NSR {cadeia.brokenAtNsr}.</strong> A
              partir daí o encadeamento não fecha: houve alteração fora da
              aplicação.
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Label>Competência</Label>
          <Input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
        <div className="min-w-64 flex-1">
          <Label>Servidor</Label>
          <Select value={linkId} onValueChange={setLinkId}>
            <SelectTrigger>
              <SelectValue placeholder="Selecione o vínculo" />
            </SelectTrigger>
            <SelectContent>
              {servidores.map((s) => (
                <SelectItem
                  key={s.employment_link_id}
                  value={s.employment_link_id}
                >
                  {s.registration_number ? `${s.registration_number} — ` : ""}
                  {s.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setPunchTime("");
              setPunchOpen(true);
            }}
            disabled={!linkId}
          >
            <Plus className="size-4" /> Registrar marcação
          </Button>
        )}
        {canManage && (
          <Button
            variant="outline"
            onClick={() => setDepositOpen(true)}
            disabled={!linkId}
          >
            Depositar na folha
          </Button>
        )}
      </div>

      {linkId && apuracao && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Previsto" value={hm(apuracao.totals.expectedMinutes)} />
          <Stat label="Trabalhado" value={hm(apuracao.totals.workedMinutes)} />
          <Stat label="Extras" value={hm(apuracao.totals.extraMinutes)} />
          <Stat
            label="Saldo"
            value={hm(
              apuracao.totals.extraMinutes - apuracao.totals.faltaMinutes,
              true,
            )}
          />
        </div>
      )}

      {linkId && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <h2 className="font-bold p-3">Marcações do período</h2>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">NSR</th>
                <th className="p-3 font-semibold">Marcação</th>
                <th className="p-3 font-semibold">Origem</th>
                <th className="p-3 font-semibold">Hash do registro</th>
                <th className="p-3 font-semibold">Comprovante</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="p-3 tabular-nums">{p.nsr}</td>
                  <td className="p-3 tabular-nums">{dataHora(p.punch_time)}</td>
                  <td className="p-3">{p.source}</td>
                  <td className="p-3 font-mono text-xs">
                    {p.record_hash.slice(0, 16)}…
                  </td>
                  <td className="p-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => abrirComprovante(p.id)}
                    >
                      Emitir
                    </Button>
                  </td>
                </tr>
              ))}
              {lista.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="p-6 text-center text-muted-foreground"
                  >
                    Sem marcações no período.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {linkId && mirror && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <h2 className="font-bold p-3">
            Espelho de ponto — total {hm(mirror.totalMinutes)}
          </h2>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Dia</th>
                <th className="p-3 font-semibold">Marcações</th>
                <th className="p-3 font-semibold text-right">Trabalhado</th>
                <th className="p-3 font-semibold">Situação</th>
              </tr>
            </thead>
            <tbody>
              {mirror.days.map((d) => (
                <tr key={d.date} className="border-b last:border-0">
                  <td className="p-3 tabular-nums">{d.date}</td>
                  <td className="p-3 tabular-nums">
                    {d.punches
                      .map((p) =>
                        new Date(p.punchTime).toLocaleTimeString("pt-BR", {
                          hour: "2-digit",
                          minute: "2-digit",
                        }),
                      )
                      .join("  ")}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {hm(d.workedMinutes)}
                  </td>
                  <td className="p-3">
                    {d.isHoliday && (
                      <Badge variant="secondary">
                        Feriado{d.holidayName ? `: ${d.holidayName}` : ""}
                      </Badge>
                    )}
                    {d.openInterval && (
                      <Badge variant="destructive" className="ml-1">
                        Intervalo aberto
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
              {mirror.days.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="p-6 text-center text-muted-foreground"
                  >
                    Nada a exibir no período.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-3 p-3">
          <h2 className="font-bold">
            <CalendarDays className="inline size-4 mr-1" /> Feriados
          </h2>
          {canManage && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFeriadoOpen(true)}
            >
              <Plus className="size-4" /> Novo feriado
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Data</th>
                <th className="p-3 font-semibold">Nome</th>
                <th className="p-3 font-semibold">Tipo</th>
                <th className="p-3 font-semibold">Abrangência</th>
              </tr>
            </thead>
            <tbody>
              {(holidays?.holidays ?? []).map((h) => (
                <tr key={h.id} className="border-b last:border-0">
                  <td className="p-3 tabular-nums">
                    {String(h.day).padStart(2, "0")}/
                    {String(h.month).padStart(2, "0")}
                    {h.year ? `/${h.year}` : ""}
                  </td>
                  <td className="p-3">{h.name}</td>
                  <td className="p-3">{h.holiday_type}</td>
                  <td className="p-3 text-muted-foreground">
                    {h.tenant_id ? "deste ente" : "nacional"}
                  </td>
                </tr>
              ))}
              {(holidays?.holidays ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="p-6 text-center text-muted-foreground"
                  >
                    Nenhum feriado cadastrado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={punchOpen} onOpenChange={setPunchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar marcação</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              A marcação é <strong>imutável</strong>: não há edição nem
              exclusão. Uma correção se faz por nova marcação, e as duas ficam
              na cadeia.
            </p>
            <div>
              <Label>Data e hora (vazio = agora)</Label>
              <Input
                type="datetime-local"
                value={punchTime}
                onChange={(e) => setPunchTime(e.target.value)}
              />
            </div>
            <div>
              <Label>Origem</Label>
              <Select value={punchSource} onValueChange={setPunchSource}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual (RH)</SelectItem>
                  <SelectItem value="app">Aplicativo</SelectItem>
                  <SelectItem value="rep">REP</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitPunch} disabled={busy}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(receipt)}
        onOpenChange={(o) => !o && setReceipt(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Comprovante de marcação (interno)</DialogTitle>
          </DialogHeader>
          {receipt && (
            <div className="space-y-2 text-sm">
              <div>
                <strong>{receipt.employee.full_name}</strong> — matrícula{" "}
                {receipt.employee.registration_number}
              </div>
              {receipt.employee.cpf && <div>CPF {receipt.employee.cpf}</div>}
              {receipt.employee.unit_name && (
                <div>Lotação: {receipt.employee.unit_name}</div>
              )}
              <div>NSR {receipt.nsr}</div>
              <div>Marcação: {dataHora(receipt.punch_time)}</div>
              <div>Origem: {receipt.source}</div>
              <div className="rounded-lg border bg-muted/40 p-2">
                Código verificador:{" "}
                <span className="font-mono font-bold">
                  {receipt.verification_code}
                </span>
              </div>
              <div className="break-all font-mono text-xs text-muted-foreground">
                {receipt.record_hash}
              </div>
              <p className="text-xs text-muted-foreground">
                Comprovante interno. O comprovante oficial da Portaria MTP
                671/2021 exige homologação e não é este.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Depositar apuração na folha de {month}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Nada é adivinhado: o RH escolhe as rubricas, o adicional e o
              divisor do salário-hora. Informe ao menos uma rubrica.
            </p>
            <div>
              <Label>Rubrica de horas extras</Label>
              <Select
                value={depForm.overtime_rubric_id}
                onValueChange={(v) =>
                  setDepForm((f) => ({ ...f, overtime_rubric_id: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Nenhuma" />
                </SelectTrigger>
                <SelectContent>
                  {rubricList.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.code} — {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Rubrica de faltas</Label>
              <Select
                value={depForm.absence_rubric_id}
                onValueChange={(v) =>
                  setDepForm((f) => ({ ...f, absence_rubric_id: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Nenhuma" />
                </SelectTrigger>
                <SelectContent>
                  {rubricList.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.code} — {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Adicional</Label>
                <Input
                  type="number"
                  step="0.05"
                  value={depForm.overtime_multiplier}
                  onChange={(e) =>
                    setDepForm((f) => ({
                      ...f,
                      overtime_multiplier: e.target.value,
                    }))
                  }
                />
              </div>
              <div>
                <Label>Horas/mês</Label>
                <Input
                  type="number"
                  value={depForm.monthly_base_hours}
                  onChange={(e) =>
                    setDepForm((f) => ({
                      ...f,
                      monthly_base_hours: e.target.value,
                    }))
                  }
                />
              </div>
              <div>
                <Label>Tolerância (min)</Label>
                <Input
                  type="number"
                  value={depForm.tolerance_minutes}
                  onChange={(e) =>
                    setDepForm((f) => ({
                      ...f,
                      tolerance_minutes: e.target.value,
                    }))
                  }
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitDeposit}
              disabled={
                busy ||
                (!depForm.overtime_rubric_id && !depForm.absence_rubric_id)
              }
            >
              Depositar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={feriadoOpen} onOpenChange={setFeriadoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo feriado</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome</Label>
              <Input
                value={feriado.name}
                onChange={(e) =>
                  setFeriado((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Tipo</Label>
              <Select
                value={feriado.holiday_type}
                onValueChange={(v) =>
                  setFeriado((f) => ({ ...f, holiday_type: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="municipal">Municipal</SelectItem>
                  <SelectItem value="estadual">Estadual</SelectItem>
                  <SelectItem value="facultativo">Ponto facultativo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Dia</Label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={feriado.day}
                  onChange={(e) =>
                    setFeriado((f) => ({ ...f, day: e.target.value }))
                  }
                />
              </div>
              <div>
                <Label>Mês</Label>
                <Input
                  type="number"
                  min={1}
                  max={12}
                  value={feriado.month}
                  onChange={(e) =>
                    setFeriado((f) => ({ ...f, month: e.target.value }))
                  }
                />
              </div>
              <div>
                <Label>Ano</Label>
                <Input
                  type="number"
                  placeholder="todo ano"
                  value={feriado.year}
                  onChange={(e) =>
                    setFeriado((f) => ({ ...f, year: e.target.value }))
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Ano em branco: o feriado recorre em todos os anos.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={submitFeriado}
              disabled={busy || feriado.name.trim().length < 2}
            >
              Gravar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
