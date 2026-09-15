import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BadgeDollarSign, Plus, HandCoins } from "lucide-react";
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
  getBudgetRevenues,
  saveBudgetRevenue,
  recordRevenueCollection,
  getRevenueCollections,
  reverseRevenueCollection,
} from "@/lib/revenue.functions";

import { AppShell } from "@/components/AppShell";
import { SelectClassificacao } from "@/components/SelectClassificacao";
import { SelectContaTesouraria } from "@/components/SelectContaTesouraria";

export const Route = createFileRoute("/receitas")({ component: Page });

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

type Revenue = {
  id: string;
  exercicio: number;
  natureza_receita: string;
  fonte_recurso: string;
  descricao: string;
  valor_previsto: string;
  valor_arrecadado: string;
  saldo: string;
  status: string;
};
type Collection = {
  id: string;
  data_arrecadacao: string;
  valor: string;
  historico: string;
  estornada: boolean;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getBudgetRevenues);
  const save = useServerFn(saveBudgetRevenue);
  const collect = useServerFn(recordRevenueCollection);
  const loadCollections = useServerFn(getRevenueCollections);
  const reverse = useServerFn(reverseRevenueCollection);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collectTarget, setCollectTarget] = useState<Revenue | null>(null);
  const [collectForm, setCollectForm] = useState({ valor: "", historico: "" });
  // O4-18 — arrecadar exige dizer em que conta o dinheiro entrou: é o que credita
  // a tesouraria e faz o caixa acompanhar a receita.
  const [contaArrecadacao, setContaArrecadacao] = useState("");
  const [form, setForm] = useState({
    exercicio: String(new Date().getFullYear()),
    natureza_receita: "",
    fonte_recurso: "",
    descricao: "",
    valor_previsto: "",
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const { data } = useQuery({
    queryKey: ["budget-revenues", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: collections } = useQuery({
    queryKey: ["revenue-collections", activeTenant?.id, expanded],
    enabled: Boolean(activeTenant) && Boolean(expanded),
    queryFn: () =>
      loadCollections({
        data: { tenant_id: activeTenant!.id, revenue_id: expanded! },
      }),
  });

  const revenues = (data?.revenues ?? []) as Revenue[];
  const totais = data?.totais ?? { previsto: 0, arrecadado: 0 };
  const canManage = data?.canManage ?? false;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["budget-revenues", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["revenue-collections", activeTenant?.id],
    });
  };

  const doReverse = async (c: Collection) => {
    if (!activeTenant) return;
    const motivo = window.prompt("Motivo do estorno da arrecadação:");
    if (!motivo || motivo.trim().length < 3) return;
    try {
      await reverse({
        data: {
          tenant_id: activeTenant.id,
          collection_id: c.id,
          motivo: motivo.trim(),
        },
      });
      toast.success("Arrecadação estornada");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao estornar");
    }
  };

  const submitCreate = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await save({
        data: {
          tenant_id: activeTenant.id,
          exercicio: Number(form.exercicio),
          natureza_receita: form.natureza_receita.trim(),
          fonte_recurso: form.fonte_recurso.trim(),
          descricao: form.descricao.trim(),
          valor_previsto: Number(form.valor_previsto),
          status: "ativa",
        },
      });
      toast.success("Receita cadastrada");
      setOpen(false);
      setForm({
        exercicio: String(new Date().getFullYear()),
        natureza_receita: "",
        fonte_recurso: "",
        descricao: "",
        valor_previsto: "",
      });
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const submitCollect = async () => {
    if (!activeTenant || !collectTarget || !contaArrecadacao) return;
    setBusy(true);
    try {
      await collect({
        data: {
          tenant_id: activeTenant.id,
          revenue_id: collectTarget.id,
          account_id: contaArrecadacao,
          data_arrecadacao: hoje(),
          valor: Number(collectForm.valor),
          historico: collectForm.historico.trim(),
        },
      });
      toast.success("Arrecadação registrada e creditada na conta");
      setCollectTarget(null);
      setCollectForm({ valor: "", historico: "" });
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao arrecadar",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <BadgeDollarSign className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Receitas</h1>
            <p className="text-sm text-muted-foreground">
              Previsão (LOA) e arrecadação da receita (Lei 4.320)
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> Nova receita
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">Previsto</div>
          <div className="text-xl font-bold">{brl(totais.previsto)}</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">Arrecadado</div>
          <div className="text-xl font-bold text-primary">
            {brl(totais.arrecadado)}
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">% Realização</div>
          <div className="text-xl font-bold">
            {totais.previsto > 0
              ? ((totais.arrecadado / totais.previsto) * 100).toFixed(1)
              : "0.0"}
            %
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Natureza</th>
              <th className="p-3 font-semibold">Descrição</th>
              <th className="p-3 font-semibold text-right">Previsto</th>
              <th className="p-3 font-semibold text-right">Arrecadado</th>
              <th className="p-3 font-semibold text-right">Saldo</th>
              <th className="p-3 font-semibold">Situação</th>
              <th className="p-3 font-semibold">Ações</th>
            </tr>
          </thead>
          <tbody>
            {revenues.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="p-3 font-medium tabular-nums">
                  {r.natureza_receita}
                </td>
                <td className="p-3">{r.descricao}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(r.valor_previsto)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(r.valor_arrecadado)}
                </td>
                <td className="p-3 text-right tabular-nums">{brl(r.saldo)}</td>
                <td className="p-3">
                  <Badge
                    variant={r.status === "ativa" ? "default" : "secondary"}
                  >
                    {r.status}
                  </Badge>
                </td>
                <td className="p-3">
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setExpanded((e) => (e === r.id ? null : r.id))
                      }
                    >
                      {expanded === r.id ? "Ocultar" : "Extrato"}
                    </Button>
                    {canManage && r.status === "ativa" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setCollectTarget(r);
                          setCollectForm({ valor: "", historico: "" });
                        }}
                      >
                        <HandCoins className="size-4" /> Arrecadar
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {revenues.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhuma receita cadastrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {expanded && (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <h2 className="font-bold p-3">
            Extrato de arrecadação
            {collections ? ` — total ${brl(collections.total)}` : ""}
          </h2>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Data</th>
                <th className="p-3 font-semibold">Histórico</th>
                <th className="p-3 font-semibold text-right">Valor</th>
                {canManage && <th className="p-3 font-semibold">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {((collections?.collections ?? []) as Collection[]).map((c) => (
                <tr
                  key={c.id}
                  className={`border-b last:border-0 ${
                    c.estornada ? "text-muted-foreground line-through" : ""
                  }`}
                >
                  <td className="p-3">{c.data_arrecadacao}</td>
                  <td className="p-3">
                    {c.historico}
                    {c.estornada && (
                      <Badge variant="outline" className="ml-2 no-underline">
                        estornada
                      </Badge>
                    )}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {brl(c.valor)}
                  </td>
                  {canManage && (
                    <td className="p-3">
                      {!c.estornada && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doReverse(c)}
                        >
                          Estornar
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {(collections?.collections ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={canManage ? 4 : 3}
                    className="p-6 text-center text-muted-foreground"
                  >
                    Nenhuma arrecadação lançada.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Nova receita */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova receita</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Exercício</Label>
                <Input
                  type="number"
                  value={form.exercicio}
                  onChange={(e) => set("exercicio", e.target.value)}
                />
              </div>
              <div>
                <Label>Natureza (ex.: 1.1.1.8)</Label>
                <Input
                  value={form.natureza_receita}
                  onChange={(e) => set("natureza_receita", e.target.value)}
                />
              </div>
            </div>
            <SelectClassificacao
              tipo="fonte_recurso"
              label="Fonte de recurso"
              value={form.fonte_recurso}
              onChange={(c) => set("fonte_recurso", c)}
            />
            <div>
              <Label>Descrição</Label>
              <Input
                value={form.descricao}
                onChange={(e) => set("descricao", e.target.value)}
              />
            </div>
            <div>
              <Label>Valor previsto</Label>
              <Input
                type="number"
                step="0.01"
                value={form.valor_previsto}
                onChange={(e) => set("valor_previsto", e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitCreate} disabled={busy}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Arrecadar */}
      <Dialog
        open={Boolean(collectTarget)}
        onOpenChange={(o) => !o && setCollectTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Arrecadar — {collectTarget?.descricao}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <SelectContaTesouraria
              value={contaArrecadacao}
              onChange={setContaArrecadacao}
            />
            <div>
              <Label>Valor arrecadado</Label>
              <Input
                type="number"
                step="0.01"
                value={collectForm.valor}
                onChange={(e) =>
                  setCollectForm((f) => ({ ...f, valor: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Histórico</Label>
              <Input
                value={collectForm.historico}
                onChange={(e) =>
                  setCollectForm((f) => ({ ...f, historico: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitCollect}
              disabled={busy || !collectForm.valor || !contaArrecadacao}
            >
              Registrar arrecadação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
