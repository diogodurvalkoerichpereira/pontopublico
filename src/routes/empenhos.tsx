import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ReceiptText,
  CheckCircle2,
  DollarSign,
  Ban,
  Scissors,
  Plus,
} from "lucide-react";
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
  getBudgetCommitments,
  getCommitmentsByCredor,
  transitionBudgetCommitment,
  partiallyCancelBudgetCommitment,
  createBudgetCommitment,
} from "@/lib/budget.functions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type CredorPos = {
  credor: string;
  qtd: number;
  empenhado: number;
  a_liquidar: number;
  a_pagar: number;
  pago: number;
};

import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/empenhos")({ component: Page });

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

type Commitment = {
  id: string;
  numero: string;
  data_empenho: string;
  credor: string;
  historico: string;
  valor: string;
  status: string;
  natureza_despesa: string;
  unidade_orcamentaria: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  empenhado: "secondary",
  liquidado: "outline",
  pago: "default",
  anulado: "destructive",
};

function Content() {
  const { activeTenant, hasTenantPermission } = useAuth();
  const load = useServerFn(getBudgetCommitments);
  const transition = useServerFn(transitionBudgetCommitment);
  const partialCancel = useServerFn(partiallyCancelBudgetCommitment);
  // Empenhar (Lei 4.320 art. 58): primeiro estagio da despesa. Sem esta acao a
  // cadeia empenho -> liquidacao -> pagamento nao tem como comecar pela tela.
  const create = useServerFn(createBudgetCommitment);
  const loadApps = useServerFn(getBudgetAppropriations);
  const qc = useQueryClient();
  const canManage = hasTenantPermission("budget.manage");

  const hoje = () => new Date().toISOString().slice(0, 10);
  const [novoOpen, setNovoOpen] = useState(false);
  const [form, setForm] = useState({
    appropriation_id: "",
    data_empenho: hoje(),
    tipo: "ordinario",
    credor: "",
    historico: "",
    valor: "",
  });
  const setF = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const [pcTarget, setPcTarget] = useState<Commitment | null>(null);
  const [pcValor, setPcValor] = useState("");
  const [pcMotivo, setPcMotivo] = useState("");
  const [busy, setBusy] = useState(false);

  const loadByCredor = useServerFn(getCommitmentsByCredor);
  const { data } = useQuery({
    queryKey: ["budget-commitments", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: byCredor } = useQuery({
    queryKey: ["commitments-by-credor", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadByCredor({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data ?? []) as Commitment[];
  const credores = (byCredor?.credores ?? []) as CredorPos[];

  // Dotacoes disponiveis para empenhar (saldo = orcado - empenhado - bloqueado).
  const { data: appsData } = useQuery({
    queryKey: ["budget-appropriations", activeTenant?.id],
    enabled: Boolean(activeTenant) && canManage,
    queryFn: () => loadApps({ data: { tenant_id: activeTenant!.id } }),
  });
  const dotacoes = (
    (appsData?.appropriations ?? []) as Array<{
      id: string;
      exercicio: number;
      unidade_orcamentaria: string;
      natureza_despesa: string;
      fonte_recurso: string;
      saldo: string;
      status: string;
    }>
  ).filter((a) => a.status === "ativa" && Number(a.saldo) > 0);

  const refresh = () => {
    qc.invalidateQueries({
      queryKey: ["budget-commitments", activeTenant?.id],
    });
    qc.invalidateQueries({
      queryKey: ["commitments-by-credor", activeTenant?.id],
    });
    // O empenho reserva saldo da dotacao: a tela de orcamento precisa relerar.
    qc.invalidateQueries({
      queryKey: ["budget-appropriations", activeTenant?.id],
    });
  };

  const submitNovo = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      const r = await create({
        data: {
          tenant_id: activeTenant.id,
          appropriation_id: form.appropriation_id,
          data_empenho: form.data_empenho,
          tipo: form.tipo as "ordinario" | "global" | "estimativo",
          credor: form.credor.trim(),
          historico: form.historico.trim(),
          valor: Number(form.valor),
        },
      });
      toast.success(`Empenho nº ${r.numero} emitido`);
      setNovoOpen(false);
      setForm({
        appropriation_id: "",
        data_empenho: hoje(),
        tipo: "ordinario",
        credor: "",
        historico: "",
        valor: "",
      });
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao empenhar");
    } finally {
      setBusy(false);
    }
  };

  const doTransition = async (
    c: Commitment,
    action: "liquidar" | "pagar" | "anular",
  ) => {
    if (!activeTenant) return;
    try {
      await transition({
        data: { tenant_id: activeTenant.id, commitment_id: c.id, action },
      });
      toast.success("Estágio atualizado");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha na transição",
      );
    }
  };

  const submitPartial = async () => {
    if (!activeTenant || !pcTarget) return;
    setBusy(true);
    try {
      const r = await partialCancel({
        data: {
          tenant_id: activeTenant.id,
          commitment_id: pcTarget.id,
          novo_valor: Number(pcValor),
          motivo: pcMotivo.trim(),
        },
      });
      toast.success(`Empenho reduzido — devolvido ${brl(r.devolvido)}`);
      setPcTarget(null);
      setPcValor("");
      setPcMotivo("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao anular");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <ReceiptText className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Empenhos</h1>
            <p className="text-sm text-muted-foreground">
              Estágios da despesa (Lei 4.320): empenhado → liquidado → pago
            </p>
          </div>
        </div>
        {canManage && (
          <Button
            variant="outline"
            onClick={() => setNovoOpen(true)}
            disabled={dotacoes.length === 0}
            title={
              dotacoes.length === 0
                ? "Nenhuma dotação ativa com saldo — cadastre em Orçamento"
                : undefined
            }
          >
            <Plus className="size-4" /> Novo empenho
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Nº</th>
              <th className="p-3 font-semibold">Credor</th>
              <th className="p-3 font-semibold">Dotação</th>
              <th className="p-3 font-semibold text-right">Valor</th>
              <th className="p-3 font-semibold">Estágio</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className="border-b last:border-0">
                <td className="p-3 font-medium tabular-nums">{c.numero}</td>
                <td className="p-3">{c.credor}</td>
                <td className="p-3 text-muted-foreground">
                  {c.unidade_orcamentaria} · {c.natureza_despesa}
                </td>
                <td className="p-3 text-right tabular-nums">{brl(c.valor)}</td>
                <td className="p-3">
                  <Badge variant={statusVariant[c.status] ?? "secondary"}>
                    {c.status}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    <div className="flex gap-2 flex-wrap">
                      {c.status === "empenhado" && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => doTransition(c, "liquidar")}
                          >
                            <CheckCircle2 className="size-4" /> Liquidar
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setPcTarget(c);
                              setPcValor("");
                              setPcMotivo("");
                            }}
                          >
                            <Scissors className="size-4" /> Anular parcial
                          </Button>
                        </>
                      )}
                      {c.status === "liquidado" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doTransition(c, "pagar")}
                        >
                          <DollarSign className="size-4" /> Pagar
                        </Button>
                      )}
                      {(c.status === "empenhado" ||
                        c.status === "liquidado") && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doTransition(c, "anular")}
                        >
                          <Ban className="size-4" /> Anular
                        </Button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 6 : 5}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum empenho registrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {credores.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-bold">Posição por credor</h2>
          <div className="rounded-xl border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-3 font-semibold">Credor</th>
                  <th className="p-3 font-semibold text-right">Empenhado</th>
                  <th className="p-3 font-semibold text-right">A liquidar</th>
                  <th className="p-3 font-semibold text-right">A pagar</th>
                  <th className="p-3 font-semibold text-right">Pago</th>
                </tr>
              </thead>
              <tbody>
                {credores.map((c) => (
                  <tr key={c.credor} className="border-b last:border-0">
                    <td className="p-3 font-medium">{c.credor}</td>
                    <td className="p-3 text-right tabular-nums">
                      {brl(c.empenhado)}
                    </td>
                    <td className="p-3 text-right tabular-nums text-muted-foreground">
                      {c.a_liquidar ? brl(c.a_liquidar) : "—"}
                    </td>
                    <td className="p-3 text-right tabular-nums font-semibold text-amber-600">
                      {c.a_pagar ? brl(c.a_pagar) : "—"}
                    </td>
                    <td className="p-3 text-right tabular-nums text-emerald-600">
                      {c.pago ? brl(c.pago) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            A pagar = empenhos liquidados prontos para ordem bancária.
          </p>
        </div>
      )}

      {/* Anulação parcial */}
      <Dialog
        open={Boolean(pcTarget)}
        onOpenChange={(o) => !o && setPcTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Anulação parcial — empenho {pcTarget?.numero}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Valor atual: {brl(pcTarget?.valor ?? 0)}. Informe o novo valor
              (menor que o atual); a diferença volta à dotação.
            </p>
            <div>
              <Label>Novo valor</Label>
              <Input
                type="number"
                step="0.01"
                value={pcValor}
                onChange={(e) => setPcValor(e.target.value)}
              />
            </div>
            <div>
              <Label>Motivo</Label>
              <Input
                value={pcMotivo}
                onChange={(e) => setPcMotivo(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitPartial}
              disabled={busy || !pcValor || pcMotivo.trim().length < 3}
            >
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Novo empenho (Lei 4.320 art. 58) — reserva saldo da dotação */}
      <Dialog open={novoOpen} onOpenChange={setNovoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo empenho</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Dotação orçamentária</Label>
              <Select
                value={form.appropriation_id}
                onValueChange={(v) => setF("appropriation_id", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a dotação" />
                </SelectTrigger>
                <SelectContent>
                  {dotacoes.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.exercicio} · {a.unidade_orcamentaria} ·{" "}
                      {a.natureza_despesa} · fonte {a.fonte_recurso} — saldo{" "}
                      {brl(a.saldo)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                O empenho nunca excede o saldo (orçado − empenhado − bloqueado).
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>Data</Label>
                <Input
                  type="date"
                  value={form.data_empenho}
                  onChange={(e) => setF("data_empenho", e.target.value)}
                />
              </div>
              <div>
                <Label>Tipo</Label>
                <Select
                  value={form.tipo}
                  onValueChange={(v) => setF("tipo", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ordinario">Ordinário</SelectItem>
                    <SelectItem value="global">Global</SelectItem>
                    <SelectItem value="estimativo">Estimativo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Valor</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.valor}
                  onChange={(e) => setF("valor", e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>Credor</Label>
              <Input
                value={form.credor}
                onChange={(e) => setF("credor", e.target.value)}
              />
            </div>
            <div>
              <Label>Histórico</Label>
              <Input
                value={form.historico}
                onChange={(e) => setF("historico", e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitNovo}
              disabled={
                busy ||
                !form.appropriation_id ||
                form.credor.trim().length < 2 ||
                form.historico.trim().length < 3 ||
                !(Number(form.valor) > 0)
              }
            >
              Empenhar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
