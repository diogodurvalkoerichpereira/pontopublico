import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarClock, Plus, HandCoins, Ban } from "lucide-react";
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
  getInstallmentPlans,
  getInstallments,
  createInstallmentPlan,
  payInstallment,
  rescindInstallmentPlan,
  getInstallmentPlansSummary,
} from "@/lib/tax-installments.functions";
import { getTaxCredits } from "@/lib/taxes.functions";

import { AppShell } from "@/components/AppShell";
import { SelectContaTesouraria } from "@/components/SelectContaTesouraria";

export const Route = createFileRoute("/parcelamentos")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("taxes.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

type Plan = {
  id: string;
  credit_id: string;
  numero_parcelas: number;
  valor_total: string;
  data_acordo: string;
  status: string;
  parcelas_pagas: string;
};
type Installment = {
  id: string;
  numero: number;
  valor: string;
  vencimento: string;
  status: string;
};
type Credit = {
  id: string;
  tributo: string;
  contribuinte: string;
  inscricao: string;
  saldo: string;
  status: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);

function Content() {
  const { activeTenant } = useAuth();
  const loadPlans = useServerFn(getInstallmentPlans);
  const loadInstallments = useServerFn(getInstallments);
  const loadCredits = useServerFn(getTaxCredits);
  const create = useServerFn(createInstallmentPlan);
  const pay = useServerFn(payInstallment);
  const rescind = useServerFn(rescindInstallmentPlan);
  const loadSummary = useServerFn(getInstallmentPlansSummary);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [parcelaAPagar, setParcelaAPagar] = useState<Installment | null>(null);
  const [contaPagamento, setContaPagamento] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState({
    credit_id: "",
    numero_parcelas: "12",
    data_acordo: hoje(),
    primeiro_vencimento: hoje(),
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const { data } = useQuery({
    queryKey: ["installment-plans", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadPlans({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: creditsData } = useQuery({
    queryKey: ["tax-credits", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadCredits({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: installments } = useQuery({
    queryKey: ["installments", activeTenant?.id, expanded],
    enabled: Boolean(activeTenant) && Boolean(expanded),
    queryFn: () =>
      loadInstallments({
        data: { tenant_id: activeTenant!.id, plan_id: expanded! },
      }),
  });

  const { data: summary } = useQuery({
    queryKey: ["installment-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadSummary({
        data: { tenant_id: activeTenant!.id, data_referencia: hoje() },
      }),
  });

  const plans = (data?.plans ?? []) as Plan[];
  const canManage = data?.canManage ?? false;
  const parcelaveis = useMemo(
    () =>
      ((creditsData?.credits ?? []) as Credit[]).filter(
        (c) => c.status === "divida_ativa" && Number(c.saldo) > 0,
      ),
    [creditsData],
  );

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["installment-plans", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["installments", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["tax-credits", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["installment-summary", activeTenant?.id],
    });
  };

  const submitCreate = async () => {
    if (!activeTenant || !form.credit_id) return;
    setBusy(true);
    try {
      await create({
        data: {
          tenant_id: activeTenant.id,
          credit_id: form.credit_id,
          numero_parcelas: Number(form.numero_parcelas),
          data_acordo: form.data_acordo,
          primeiro_vencimento: form.primeiro_vencimento,
        },
      });
      toast.success("Parcelamento criado");
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao parcelar");
    } finally {
      setBusy(false);
    }
  };

  // O4-18 — parcela paga é dinheiro que entrou: sem dizer em que conta, a
  // tesouraria continuaria sem enxergar a arrecadação por parcelamento.
  const doPay = async () => {
    if (!activeTenant || !parcelaAPagar || !contaPagamento) return;
    try {
      await pay({
        data: {
          tenant_id: activeTenant.id,
          installment_id: parcelaAPagar.id,
          account_id: contaPagamento,
          data_pagamento: hoje(),
        },
      });
      toast.success("Parcela paga e creditada na conta");
      setParcelaAPagar(null);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao pagar");
    }
  };

  const doRescind = async (p: Plan) => {
    if (!activeTenant) return;
    try {
      const r = await rescind({
        data: {
          tenant_id: activeTenant.id,
          plan_id: p.id,
          data_referencia: hoje(),
        },
      });
      toast.success(`Rescindido (${r.parcelas_vencidas} parcelas vencidas)`);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao rescindir",
      );
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <CalendarClock className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Parcelamentos
            </h1>
            <p className="text-sm text-muted-foreground">
              Parcelamento de dívida ativa (REFIS) — pagamento e rescisão
            </p>
          </div>
        </div>
        {canManage && (
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            disabled={parcelaveis.length === 0}
          >
            <Plus className="size-4" /> Novo parcelamento
          </Button>
        )}
      </div>

      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">Planos ativos</div>
            <div className="text-2xl font-bold tabular-nums">
              {summary.planosPorStatus.ativo}
            </div>
            <div className="text-xs text-muted-foreground">
              {summary.planosPorStatus.quitado} quitados ·{" "}
              {summary.planosPorStatus.rescindido} rescindidos
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">Arrecadado</div>
            <div className="text-2xl font-bold tabular-nums">
              {brl(summary.arrecadado)}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">A receber</div>
            <div className="text-2xl font-bold tabular-nums text-primary">
              {brl(summary.aReceber)}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">
              Vencido em aberto
            </div>
            <div className="text-2xl font-bold tabular-nums text-destructive">
              {brl(summary.vencido)}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Acordo</th>
              <th className="p-3 font-semibold text-right">Total</th>
              <th className="p-3 font-semibold text-right">Parcelas</th>
              <th className="p-3 font-semibold">Situação</th>
              <th className="p-3 font-semibold">Ações</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} className="border-b last:border-0">
                <td className="p-3">{p.data_acordo}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(p.valor_total)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {p.parcelas_pagas}/{p.numero_parcelas}
                </td>
                <td className="p-3">
                  <Badge
                    variant={p.status === "ativo" ? "default" : "secondary"}
                  >
                    {p.status}
                  </Badge>
                </td>
                <td className="p-3">
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setExpanded((e) => (e === p.id ? null : p.id))
                      }
                    >
                      {expanded === p.id ? "Ocultar" : "Parcelas"}
                    </Button>
                    {canManage && p.status === "ativo" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => doRescind(p)}
                      >
                        <Ban className="size-4" /> Rescindir
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {plans.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum parcelamento.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {expanded && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <h2 className="font-bold p-3">Parcelas do acordo</h2>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Nº</th>
                <th className="p-3 font-semibold text-right">Valor</th>
                <th className="p-3 font-semibold">Vencimento</th>
                <th className="p-3 font-semibold">Situação</th>
                {canManage && <th className="p-3 font-semibold">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {((installments ?? []) as Installment[]).map((i) => (
                <tr key={i.id} className="border-b last:border-0">
                  <td className="p-3 tabular-nums">{i.numero}</td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(i.valor)}
                  </td>
                  <td className="p-3">{i.vencimento}</td>
                  <td className="p-3">
                    <Badge
                      variant={i.status === "paga" ? "default" : "secondary"}
                    >
                      {i.status}
                    </Badge>
                  </td>
                  {canManage && (
                    <td className="p-3">
                      {i.status === "aberta" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setParcelaAPagar(i)}
                        >
                          <HandCoins className="size-4" /> Pagar
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo parcelamento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Crédito em dívida ativa</Label>
              <Select
                value={form.credit_id}
                onValueChange={(v) => set("credit_id", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o crédito" />
                </SelectTrigger>
                <SelectContent>
                  {parcelaveis.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.tributo} {c.inscricao} — {c.contribuinte} (
                      {brl(c.saldo)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>Parcelas</Label>
                <Input
                  type="number"
                  value={form.numero_parcelas}
                  onChange={(e) => set("numero_parcelas", e.target.value)}
                />
              </div>
              <div>
                <Label>Data do acordo</Label>
                <Input
                  type="date"
                  value={form.data_acordo}
                  onChange={(e) => set("data_acordo", e.target.value)}
                />
              </div>
              <div>
                <Label>1º vencimento</Label>
                <Input
                  type="date"
                  value={form.primeiro_vencimento}
                  onChange={(e) => set("primeiro_vencimento", e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitCreate} disabled={busy || !form.credit_id}>
              Parcelar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(parcelaAPagar)}
        onOpenChange={(o) => !o && setParcelaAPagar(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Pagar parcela {parcelaAPagar?.numero} —{" "}
              {parcelaAPagar ? brl(parcelaAPagar.valor) : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <SelectContaTesouraria
              value={contaPagamento}
              onChange={setContaPagamento}
            />
          </div>
          <DialogFooter>
            <Button onClick={doPay} disabled={!contaPagamento}>
              Confirmar pagamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
