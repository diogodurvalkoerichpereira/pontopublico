import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PiggyBank, Plus } from "lucide-react";
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
  getBudgetAppropriations,
  saveBudgetAppropriation,
} from "@/lib/budget.functions";

export const Route = createFileRoute("/orcamento")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("budget.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Appropriation = {
  id: string;
  exercicio: number;
  unidade_orcamentaria: string;
  funcao: string;
  subfuncao: string;
  programa: string;
  acao: string;
  natureza_despesa: string;
  fonte_recurso: string;
  valor_orcado: string;
  valor_empenhado: string;
  saldo: string;
  status: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getBudgetAppropriations);
  const save = useServerFn(saveBudgetAppropriation);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    exercicio: String(new Date().getFullYear()),
    unidade_orcamentaria: "",
    funcao: "",
    subfuncao: "",
    programa: "",
    acao: "",
    natureza_despesa: "",
    fonte_recurso: "",
    valor_orcado: "",
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const { data } = useQuery({
    queryKey: ["budget-appropriations", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data?.appropriations ?? []) as Appropriation[];
  const canManage = data?.canManage ?? false;

  const totals = items.reduce(
    (acc, a) => ({
      orcado: acc.orcado + Number(a.valor_orcado),
      empenhado: acc.empenhado + Number(a.valor_empenhado),
      saldo: acc.saldo + Number(a.saldo),
    }),
    { orcado: 0, empenhado: 0, saldo: 0 },
  );

  const refresh = () =>
    qc.invalidateQueries({
      queryKey: ["budget-appropriations", activeTenant?.id],
    });

  const submit = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await save({
        data: {
          tenant_id: activeTenant.id,
          exercicio: Number(form.exercicio),
          unidade_orcamentaria: form.unidade_orcamentaria.trim(),
          funcao: form.funcao.trim(),
          subfuncao: form.subfuncao.trim(),
          programa: form.programa.trim(),
          acao: form.acao.trim(),
          natureza_despesa: form.natureza_despesa.trim(),
          fonte_recurso: form.fonte_recurso.trim(),
          valor_orcado: Number(form.valor_orcado),
          status: "ativa",
        },
      });
      toast.success("Dotação salva");
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const campos: Array<[keyof typeof form, string]> = [
    ["exercicio", "Exercício"],
    ["unidade_orcamentaria", "Unidade orçamentária"],
    ["funcao", "Função"],
    ["subfuncao", "Subfunção"],
    ["programa", "Programa"],
    ["acao", "Ação"],
    ["natureza_despesa", "Natureza da despesa"],
    ["fonte_recurso", "Fonte de recurso"],
    ["valor_orcado", "Valor orçado"],
  ];

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <PiggyBank className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Orçamento
            </h1>
            <p className="text-sm text-muted-foreground">
              Dotações orçamentárias (LOA) — orçado, empenhado e saldo
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> Nova dotação
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">Orçado</div>
          <div className="text-xl font-bold">{brl(totals.orcado)}</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">Empenhado</div>
          <div className="text-xl font-bold">{brl(totals.empenhado)}</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">Saldo</div>
          <div className="text-xl font-bold">{brl(totals.saldo)}</div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Exerc.</th>
              <th className="p-3 font-semibold">Unidade</th>
              <th className="p-3 font-semibold">Natureza</th>
              <th className="p-3 font-semibold">Fonte</th>
              <th className="p-3 font-semibold text-right">Orçado</th>
              <th className="p-3 font-semibold text-right">Empenhado</th>
              <th className="p-3 font-semibold text-right">Saldo</th>
              <th className="p-3 font-semibold">Situação</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id} className="border-b last:border-0">
                <td className="p-3">{a.exercicio}</td>
                <td className="p-3 font-medium">{a.unidade_orcamentaria}</td>
                <td className="p-3 text-muted-foreground">
                  {a.natureza_despesa}
                </td>
                <td className="p-3 text-muted-foreground">{a.fonte_recurso}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(a.valor_orcado)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(a.valor_empenhado)}
                </td>
                <td className="p-3 text-right tabular-nums">{brl(a.saldo)}</td>
                <td className="p-3">
                  <Badge
                    variant={a.status === "ativa" ? "default" : "secondary"}
                  >
                    {a.status}
                  </Badge>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhuma dotação cadastrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova dotação</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {campos.map(([k, label]) => (
              <div key={k}>
                <Label>{label}</Label>
                <Input
                  type={
                    k === "exercicio" || k === "valor_orcado"
                      ? "number"
                      : "text"
                  }
                  step={k === "valor_orcado" ? "0.01" : undefined}
                  value={form[k]}
                  onChange={(e) => set(k, e.target.value)}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button onClick={submit} disabled={busy}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
