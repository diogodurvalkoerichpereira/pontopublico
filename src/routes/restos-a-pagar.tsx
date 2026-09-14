import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileStack, Plus, HandCoins, Ban } from "lucide-react";
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
import { useAuth } from "@/lib/auth-context";
import {
  getRestosAPagar,
  inscribeRestosAPagar,
  payRestoAPagar,
  cancelRestoAPagar,
  getRestosAPagarSummary,
} from "@/lib/restos-a-pagar.functions";

import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/restos-a-pagar")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("budget.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

type Resto = {
  id: string;
  exercicio_origem: number;
  tipo: string;
  valor: string;
  inscrito_em: string;
  status: string;
  pago_em: string | null;
  numero: string;
  credor: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getRestosAPagar);
  const inscribe = useServerFn(inscribeRestosAPagar);
  const pay = useServerFn(payRestoAPagar);
  const cancel = useServerFn(cancelRestoAPagar);
  const loadSummary = useServerFn(getRestosAPagarSummary);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exercicio, setExercicio] = useState(
    String(new Date().getFullYear() - 1),
  );

  const { data } = useQuery({
    queryKey: ["restos", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: summary } = useQuery({
    queryKey: ["restos-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadSummary({ data: { tenant_id: activeTenant!.id } }),
  });
  const restos = (data?.restos ?? []) as Resto[];
  const canManage = data?.canManage ?? false;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["restos", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["restos-summary", activeTenant?.id] });
  };

  const submitInscribe = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      const r = await inscribe({
        data: {
          tenant_id: activeTenant.id,
          exercicio: Number(exercicio),
          inscrito_em: hoje(),
        },
      });
      toast.success(
        `Inscritos: ${r.processados} processados, ${r.nao_processados} não processados`,
      );
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao inscrever",
      );
    } finally {
      setBusy(false);
    }
  };

  const doPay = async (r: Resto) => {
    if (!activeTenant) return;
    try {
      await pay({
        data: {
          tenant_id: activeTenant.id,
          resto_id: r.id,
          data_pagamento: hoje(),
        },
      });
      toast.success("Resto pago");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao pagar");
    }
  };

  const doCancel = async (r: Resto) => {
    if (!activeTenant) return;
    try {
      await cancel({
        data: {
          tenant_id: activeTenant.id,
          resto_id: r.id,
          motivo: "Prescrição / insubsistência (art. 38)",
          data_cancelamento: hoje(),
        },
      });
      toast.success("Resto cancelado");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao cancelar");
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <FileStack className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Restos a Pagar
            </h1>
            <p className="text-sm text-muted-foreground">
              Empenhos não pagos inscritos (Lei 4.320, art. 36 e 38)
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> Inscrever exercício
          </Button>
        )}
      </div>

      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">Saldo a pagar</div>
            <div className="text-2xl font-bold tabular-nums text-primary">
              {brl(summary.saldoAPagar)}
            </div>
            <div className="text-xs text-muted-foreground">
              {summary.porStatus.inscrito.qtd} inscritos
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">
              A pagar — processados
            </div>
            <div className="text-2xl font-bold tabular-nums">
              {brl(summary.saldoPorTipo.processado)}
            </div>
            <div className="text-xs text-muted-foreground">
              não processados: {brl(summary.saldoPorTipo.nao_processado)}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">Pagos</div>
            <div className="text-2xl font-bold tabular-nums">
              {brl(summary.porStatus.pago.valor)}
            </div>
            <div className="text-xs text-muted-foreground">
              {summary.porStatus.pago.qtd} restos
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">Cancelados</div>
            <div className="text-2xl font-bold tabular-nums">
              {brl(summary.porStatus.cancelado.valor)}
            </div>
            <div className="text-xs text-muted-foreground">
              {summary.porStatus.cancelado.qtd} restos
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Empenho</th>
              <th className="p-3 font-semibold">Exerc.</th>
              <th className="p-3 font-semibold">Credor</th>
              <th className="p-3 font-semibold">Tipo</th>
              <th className="p-3 font-semibold text-right">Valor</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {restos.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="p-3 font-medium tabular-nums">{r.numero}</td>
                <td className="p-3">{r.exercicio_origem}</td>
                <td className="p-3">{r.credor}</td>
                <td className="p-3 capitalize">{r.tipo.replace("_", " ")}</td>
                <td className="p-3 text-right tabular-nums">{brl(r.valor)}</td>
                <td className="p-3">
                  <Badge
                    variant={
                      r.status === "pago"
                        ? "default"
                        : r.status === "cancelado"
                          ? "outline"
                          : "secondary"
                    }
                  >
                    {r.status}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    {r.status === "inscrito" && (
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doPay(r)}
                        >
                          <HandCoins className="size-4" /> Pagar
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doCancel(r)}
                        >
                          <Ban className="size-4" /> Cancelar
                        </Button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {restos.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 7 : 6}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum resto a pagar inscrito.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Inscrever restos a pagar</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Inscreve os empenhos não pagos do exercício informado (liquidados
              → processados; empenhados → não processados).
            </p>
            <div>
              <Label>Exercício de origem</Label>
              <Input
                type="number"
                value={exercicio}
                onChange={(e) => setExercicio(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitInscribe} disabled={busy}>
              Inscrever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
