import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CreditCard, Plus, ChevronsDown, Ban } from "lucide-react";
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
import { getPeopleRegistry } from "@/lib/people.functions";
import {
  getConsignmentMargin,
  registerConsignment,
  amortizeConsignment,
  cancelConsignment,
  getConsignmentsSummary,
} from "@/lib/consignments.functions";

import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/consignacoes")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("people.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

type Consignment = {
  id: string;
  tipo: string;
  consignatario: string;
  valor_parcela: string;
  parcelas_total: number;
  parcelas_pagas: number;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const tipos = [
  "emprestimo",
  "sindicato",
  "plano_saude",
  "pensao",
  "outro",
] as const;

function Content() {
  const { activeTenant } = useAuth();
  const loadPeople = useServerFn(getPeopleRegistry);
  const loadMargin = useServerFn(getConsignmentMargin);
  const register = useServerFn(registerConsignment);
  const amortize = useServerFn(amortizeConsignment);
  const cancel = useServerFn(cancelConsignment);
  const qc = useQueryClient();

  const [linkId, setLinkId] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    tipo: "emprestimo" as (typeof tipos)[number],
    consignatario: "",
    valor_parcela: "",
    parcelas_total: "12",
    inicio: new Date().toISOString().slice(0, 10),
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const { data: peopleData } = useQuery({
    queryKey: ["people-registry", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadPeople({ data: { tenant_id: activeTenant!.id, status: "todos" } }),
  });

  // Opções de vínculo (servidor + matrícula) achatando os links de cada pessoa.
  const linkOptions = useMemo(() => {
    const out: Array<{ id: string; label: string }> = [];
    for (const p of (peopleData?.people ?? []) as Array<{
      full_name: string;
      links: Array<{ id: string; registration_number: string }>;
    }>) {
      for (const l of p.links ?? [])
        out.push({
          id: l.id,
          label: `${l.registration_number} — ${p.full_name}`,
        });
    }
    return out;
  }, [peopleData]);

  const { data: margin } = useQuery({
    queryKey: ["consignment-margin", activeTenant?.id, linkId],
    enabled: Boolean(activeTenant) && Boolean(linkId),
    queryFn: () =>
      loadMargin({
        data: { tenant_id: activeTenant!.id, employment_link_id: linkId },
      }),
  });

  const consignments = (margin?.consignments ?? []) as Consignment[];
  const canManage = margin?.canManage ?? false;

  const loadSummary = useServerFn(getConsignmentsSummary);
  const { data: summary } = useQuery({
    queryKey: ["consignments-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadSummary({ data: { tenant_id: activeTenant!.id } }),
  });
  const TIPO_LABEL: Record<string, string> = {
    emprestimo: "Empréstimo",
    sindicato: "Sindicato",
    plano_saude: "Plano de saúde",
    pensao: "Pensão",
    outro: "Outro",
  };

  const refresh = () => {
    qc.invalidateQueries({
      queryKey: ["consignment-margin", activeTenant?.id, linkId],
    });
    qc.invalidateQueries({
      queryKey: ["consignments-summary", activeTenant?.id],
    });
  };

  const submit = async () => {
    if (!activeTenant || !linkId) return;
    setBusy(true);
    try {
      await register({
        data: {
          tenant_id: activeTenant.id,
          employment_link_id: linkId,
          tipo: form.tipo,
          consignatario: form.consignatario.trim(),
          valor_parcela: Number(form.valor_parcela),
          parcelas_total: Number(form.parcelas_total),
          inicio: form.inicio,
        },
      });
      toast.success("Consignação registrada");
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao registrar",
      );
    } finally {
      setBusy(false);
    }
  };

  const doAmortize = async (c: Consignment) => {
    if (!activeTenant) return;
    try {
      await amortize({
        data: {
          tenant_id: activeTenant.id,
          consignment_id: c.id,
          parcelas: 1,
        },
      });
      toast.success("Parcela amortizada");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao amortizar",
      );
    }
  };

  const doCancel = async (c: Consignment) => {
    if (!activeTenant) return;
    try {
      await cancel({
        data: { tenant_id: activeTenant.id, consignment_id: c.id },
      });
      toast.success("Consignação cancelada");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao cancelar");
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <CreditCard className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Consignações
            </h1>
            <p className="text-sm text-muted-foreground">
              Margem consignável (Lei 10.820) — registro, amortização e baixa
            </p>
          </div>
        </div>
        {canManage && linkId && (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> Nova consignação
          </Button>
        )}
      </div>

      {summary && summary.tipos.length > 0 && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <div className="flex items-baseline justify-between gap-3 p-3 flex-wrap">
            <h2 className="font-bold">Consignações ativas por tipo</h2>
            <div className="text-sm text-muted-foreground">
              {summary.totalConsignacoes} ativas ·{" "}
              <span className="font-semibold text-foreground">
                {brl(summary.totalParcela)}
              </span>
              /mês
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Tipo</th>
                <th className="p-3 font-semibold text-right">Quantidade</th>
                <th className="p-3 font-semibold text-right">Parcela/mês</th>
              </tr>
            </thead>
            <tbody>
              {summary.tipos.map((t) => (
                <tr key={t.tipo} className="border-b last:border-0">
                  <td className="p-3">{TIPO_LABEL[t.tipo] ?? t.tipo}</td>
                  <td className="p-3 text-right tabular-nums">
                    {t.quantidade}
                  </td>
                  <td className="p-3 text-right tabular-nums font-medium">
                    {brl(t.total_parcela)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-xl border bg-card p-4 max-w-md">
        <Label>Servidor / matrícula</Label>
        <Select value={linkId} onValueChange={setLinkId}>
          <SelectTrigger>
            <SelectValue placeholder="Selecione o vínculo" />
          </SelectTrigger>
          <SelectContent>
            {linkOptions.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {linkId && margin && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Base</div>
            <div className="text-lg font-bold">{brl(margin.base_salary)}</div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Margem (35%)</div>
            <div className="text-lg font-bold">{brl(margin.margem)}</div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Comprometido</div>
            <div className="text-lg font-bold">{brl(margin.comprometido)}</div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Disponível</div>
            <div className="text-lg font-bold">{brl(margin.disponivel)}</div>
          </div>
        </div>
      )}

      {linkId && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Tipo</th>
                <th className="p-3 font-semibold">Consignatário</th>
                <th className="p-3 font-semibold text-right">Parcela</th>
                <th className="p-3 font-semibold text-right">Pagas</th>
                {canManage && <th className="p-3 font-semibold">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {consignments.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="p-3 capitalize">{c.tipo.replace("_", " ")}</td>
                  <td className="p-3">{c.consignatario}</td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(c.valor_parcela)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {c.parcelas_pagas}/{c.parcelas_total}
                  </td>
                  {canManage && (
                    <td className="p-3">
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doAmortize(c)}
                        >
                          <ChevronsDown className="size-4" /> Amortizar
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doCancel(c)}
                        >
                          <Ban className="size-4" /> Cancelar
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {consignments.length === 0 && (
                <tr>
                  <td
                    colSpan={canManage ? 5 : 4}
                    className="p-6 text-center text-muted-foreground"
                  >
                    Nenhuma consignação ativa.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova consignação</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Tipo</Label>
              <Select
                value={form.tipo}
                onValueChange={(v) => set("tipo", v as (typeof tipos)[number])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tipos.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">
                      {t.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Consignatário</Label>
              <Input
                value={form.consignatario}
                onChange={(e) => set("consignatario", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>Parcela</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.valor_parcela}
                  onChange={(e) => set("valor_parcela", e.target.value)}
                />
              </div>
              <div>
                <Label>Nº parcelas</Label>
                <Input
                  type="number"
                  value={form.parcelas_total}
                  onChange={(e) => set("parcelas_total", e.target.value)}
                />
              </div>
              <div>
                <Label>Início</Label>
                <Input
                  type="date"
                  value={form.inicio}
                  onChange={(e) => set("inicio", e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submit}
              disabled={busy || !form.consignatario || !form.valor_parcela}
            >
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
