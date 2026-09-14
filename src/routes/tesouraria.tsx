import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Wallet, Plus, ArrowLeftRight, ArrowDownUp } from "lucide-react";
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
  getTreasuryAccounts,
  saveTreasuryAccount,
  recordTreasuryMovement,
  transferBetweenAccounts,
  getTreasuryLedger,
} from "@/lib/treasury.functions";
import {
  getTreasuryReconciliations,
  reconcileTreasuryAccount,
} from "@/lib/treasury-reconciliation.functions";

import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/tesouraria")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("accounting.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

type Account = {
  id: string;
  nome: string;
  tipo: string;
  banco: string | null;
  agencia: string | null;
  conta: string | null;
  saldo_atual: string;
  status: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
const hoje = () => new Date().toISOString().slice(0, 10);

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getTreasuryAccounts);
  const saveAccount = useServerFn(saveTreasuryAccount);
  const recordMovement = useServerFn(recordTreasuryMovement);
  const transfer = useServerFn(transferBetweenAccounts);
  const loadLedger = useServerFn(getTreasuryLedger);
  // O2-31 — conciliação bancária. Existia no servidor sem tela: não havia como
  // confrontar o saldo do livro com o do extrato, que é a prova de que o caixa
  // escriturado corresponde ao dinheiro em banco.
  const loadReconciliations = useServerFn(getTreasuryReconciliations);
  const conciliar = useServerFn(reconcileTreasuryAccount);
  const [reconcileAccount, setReconcileAccount] = useState<Account | null>(
    null,
  );
  const [reconcileForm, setReconcileForm] = useState({
    data_referencia: new Date().toISOString().slice(0, 10),
    saldo_extrato: "",
    observacao: "",
  });
  const qc = useQueryClient();

  const [ledgerAccount, setLedgerAccount] = useState<{
    id: string;
    nome: string;
  } | null>(null);

  const [accountOpen, setAccountOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Formulário de conta.
  const [nome, setNome] = useState("");
  const [tipo, setTipo] = useState<"caixa" | "banco">("banco");
  const [banco, setBanco] = useState("");
  const [agencia, setAgencia] = useState("");
  const [conta, setConta] = useState("");

  // Formulário de movimento.
  const [moveAccountId, setMoveAccountId] = useState("");
  const [moveTipo, setMoveTipo] = useState<"ingresso" | "saida">("ingresso");
  const [moveValor, setMoveValor] = useState("");
  const [moveHistorico, setMoveHistorico] = useState("");

  // Formulário de transferência.
  const [origemId, setOrigemId] = useState("");
  const [destinoId, setDestinoId] = useState("");
  const [transferValor, setTransferValor] = useState("");
  const [transferHistorico, setTransferHistorico] = useState("");

  const { data } = useQuery({
    queryKey: ["treasury-accounts", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });

  const { data: ledger } = useQuery({
    queryKey: ["treasury-ledger", activeTenant?.id, ledgerAccount?.id],
    enabled: Boolean(activeTenant) && Boolean(ledgerAccount),
    queryFn: () =>
      loadLedger({
        data: { tenant_id: activeTenant!.id, account_id: ledgerAccount!.id },
      }),
  });

  const accounts = (data?.accounts ?? []) as Account[];
  const canManage = data?.canManage ?? false;
  const saldoTotal = accounts
    .filter((a) => a.status === "ativa")
    .reduce((s, a) => s + Number(a.saldo_atual), 0);

  const { data: reconciliations } = useQuery({
    queryKey: ["treasury-reconciliations", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadReconciliations({ data: { tenant_id: activeTenant!.id } }),
  });
  const nomeConta = (id: string) =>
    accounts.find((a) => a.id === id)?.nome ?? id.slice(0, 8);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["treasury-accounts", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["treasury-reconciliations", activeTenant?.id],
    });
  };

  const submitReconcile = async () => {
    if (!activeTenant || !reconcileAccount) return;
    setBusy(true);
    try {
      const r = await conciliar({
        data: {
          tenant_id: activeTenant.id,
          account_id: reconcileAccount.id,
          data_referencia: reconcileForm.data_referencia,
          saldo_extrato: Number(reconcileForm.saldo_extrato),
          observacao: reconcileForm.observacao.trim() || null,
        },
      });
      toast.success(
        Math.abs(r.diferenca) < 0.005
          ? `Conciliada sem diferença (livro ${brl(r.saldo_livro)})`
          : `Conciliada com diferença de ${brl(r.diferenca)} (extrato - livro)`,
      );
      setReconcileAccount(null);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao conciliar",
      );
    } finally {
      setBusy(false);
    }
  };

  const openAccount = () => {
    setNome("");
    setTipo("banco");
    setBanco("");
    setAgencia("");
    setConta("");
    setAccountOpen(true);
  };

  const submitAccount = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await saveAccount({
        data: {
          tenant_id: activeTenant.id,
          nome: nome.trim(),
          tipo,
          banco: banco.trim() || null,
          agencia: agencia.trim() || null,
          conta: conta.trim() || null,
          status: "ativa",
        },
      });
      toast.success("Conta criada");
      setAccountOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const submitMovement = async () => {
    if (!activeTenant || !moveAccountId) return;
    setBusy(true);
    try {
      await recordMovement({
        data: {
          tenant_id: activeTenant.id,
          account_id: moveAccountId,
          tipo: moveTipo,
          data_movimento: hoje(),
          valor: Number(moveValor),
          historico: moveHistorico.trim(),
        },
      });
      toast.success("Movimento registrado");
      setMoveOpen(false);
      setMoveValor("");
      setMoveHistorico("");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha no movimento",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitTransfer = async () => {
    if (!activeTenant || !origemId || !destinoId) return;
    setBusy(true);
    try {
      await transfer({
        data: {
          tenant_id: activeTenant.id,
          origem_id: origemId,
          destino_id: destinoId,
          data_movimento: hoje(),
          valor: Number(transferValor),
          historico: transferHistorico.trim(),
        },
      });
      toast.success("Transferência realizada");
      setTransferOpen(false);
      setTransferValor("");
      setTransferHistorico("");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha na transferência",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Wallet className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Tesouraria
            </h1>
            <p className="text-sm text-muted-foreground">
              Contas de caixa e banco, movimentação e transferências
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={openAccount}>
              <Plus className="size-4" /> Nova conta
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setMoveAccountId(accounts[0]?.id ?? "");
                setMoveOpen(true);
              }}
              disabled={accounts.length === 0}
            >
              <ArrowDownUp className="size-4" /> Movimento
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setOrigemId(accounts[0]?.id ?? "");
                setDestinoId(accounts[1]?.id ?? "");
                setTransferOpen(true);
              }}
              disabled={accounts.length < 2}
            >
              <ArrowLeftRight className="size-4" /> Transferir
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="text-sm text-muted-foreground">
          Saldo consolidado (contas ativas)
        </div>
        <div className="text-2xl font-bold">{brl(saldoTotal)}</div>
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Conta</th>
              <th className="p-3 font-semibold">Tipo</th>
              <th className="p-3 font-semibold">Banco / Ag / Conta</th>
              <th className="p-3 font-semibold text-right">Saldo</th>
              <th className="p-3 font-semibold">Situação</th>
              <th className="p-3 font-semibold">Extrato</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{a.nome}</td>
                <td className="p-3 capitalize">{a.tipo}</td>
                <td className="p-3 text-muted-foreground">
                  {[a.banco, a.agencia, a.conta].filter(Boolean).join(" / ") ||
                    "—"}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(a.saldo_atual)}
                </td>
                <td className="p-3">
                  <Badge
                    variant={a.status === "ativa" ? "default" : "secondary"}
                  >
                    {a.status}
                  </Badge>
                </td>
                <td className="p-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setLedgerAccount({ id: a.id, nome: a.nome })}
                  >
                    Extrato
                  </Button>
                  {canManage && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-2"
                      onClick={() => {
                        setReconcileAccount(a);
                        setReconcileForm({
                          data_referencia: hoje(),
                          saldo_extrato: a.saldo_atual,
                          observacao: "",
                        });
                      }}
                    >
                      <ArrowDownUp className="size-4" /> Conciliar
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhuma conta cadastrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Conciliação bancária (O2-15) */}
      <div className="rounded-xl border bg-card overflow-x-auto">
        <h2 className="font-bold p-3">Conciliação bancária</h2>
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Data</th>
              <th className="p-3 font-semibold">Conta</th>
              <th className="p-3 font-semibold text-right">Saldo do livro</th>
              <th className="p-3 font-semibold text-right">Saldo do extrato</th>
              <th className="p-3 font-semibold text-right">Diferença</th>
              <th className="p-3 font-semibold">Observação</th>
            </tr>
          </thead>
          <tbody>
            {(reconciliations?.reconciliations ?? []).map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="p-3 tabular-nums">{r.data_referencia}</td>
                <td className="p-3">{nomeConta(r.account_id)}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(r.saldo_livro)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(r.saldo_extrato)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {Math.abs(Number(r.diferenca)) < 0.005 ? (
                    <Badge variant="default">Confere</Badge>
                  ) : (
                    <Badge variant="destructive">{brl(r.diferenca)}</Badge>
                  )}
                </td>
                <td className="p-3 text-muted-foreground">
                  {r.observacao ?? "—"}
                </td>
              </tr>
            ))}
            {(reconciliations?.reconciliations ?? []).length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhuma conciliação registrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Conciliar conta */}
      <Dialog
        open={Boolean(reconcileAccount)}
        onOpenChange={(o) => !o && setReconcileAccount(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Conciliar — {reconcileAccount?.nome}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Saldo do livro hoje: {brl(reconcileAccount?.saldo_atual ?? 0)}. A
              diferença registrada é extrato - livro.
            </p>
            <div>
              <Label>Data de referência</Label>
              <Input
                type="date"
                value={reconcileForm.data_referencia}
                onChange={(e) =>
                  setReconcileForm((f) => ({
                    ...f,
                    data_referencia: e.target.value,
                  }))
                }
              />
            </div>
            <div>
              <Label>Saldo do extrato bancário</Label>
              <Input
                type="number"
                step="0.01"
                value={reconcileForm.saldo_extrato}
                onChange={(e) =>
                  setReconcileForm((f) => ({
                    ...f,
                    saldo_extrato: e.target.value,
                  }))
                }
              />
            </div>
            <div>
              <Label>Observação</Label>
              <Input
                value={reconcileForm.observacao}
                onChange={(e) =>
                  setReconcileForm((f) => ({
                    ...f,
                    observacao: e.target.value,
                  }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitReconcile}
              disabled={busy || reconcileForm.saldo_extrato.trim() === ""}
            >
              Conciliar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Extrato da conta */}
      <Dialog
        open={Boolean(ledgerAccount)}
        onOpenChange={(o) => !o && setLedgerAccount(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Extrato — {ledgerAccount?.nome}</DialogTitle>
          </DialogHeader>
          {ledger && (
            <div className="mb-2 text-sm text-muted-foreground">
              Entradas <b className="text-foreground">{brl(ledger.entradas)}</b>{" "}
              · Saídas <b className="text-foreground">{brl(ledger.saidas)}</b>
            </div>
          )}
          <div className="max-h-80 overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-2 font-semibold">Data</th>
                  <th className="p-2 font-semibold">Movimento</th>
                  <th className="p-2 font-semibold text-right">Valor</th>
                  <th className="p-2 font-semibold text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {(ledger?.movements ?? []).map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="p-2">{m.data_movimento}</td>
                    <td className="p-2 capitalize">
                      {m.tipo.replace(/_/g, " ")}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {brl(m.valor)}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {brl(m.saldo_apos)}
                    </td>
                  </tr>
                ))}
                {(ledger?.movements ?? []).length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="p-4 text-center text-muted-foreground"
                    >
                      Sem movimentos.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Nova conta */}
      <Dialog open={accountOpen} onOpenChange={setAccountOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova conta</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome</Label>
              <Input value={nome} onChange={(e) => setNome(e.target.value)} />
            </div>
            <div>
              <Label>Tipo</Label>
              <Select
                value={tipo}
                onValueChange={(v) => setTipo(v as "caixa" | "banco")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="banco">Banco</SelectItem>
                  <SelectItem value="caixa">Caixa</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {tipo === "banco" && (
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label>Banco</Label>
                  <Input
                    value={banco}
                    onChange={(e) => setBanco(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Agência</Label>
                  <Input
                    value={agencia}
                    onChange={(e) => setAgencia(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Conta</Label>
                  <Input
                    value={conta}
                    onChange={(e) => setConta(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={submitAccount} disabled={busy}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Movimento */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar movimento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Conta</Label>
              <Select value={moveAccountId} onValueChange={setMoveAccountId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tipo</Label>
              <Select
                value={moveTipo}
                onValueChange={(v) => setMoveTipo(v as "ingresso" | "saida")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ingresso">Ingresso</SelectItem>
                  <SelectItem value="saida">Saída</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Valor</Label>
              <Input
                type="number"
                step="0.01"
                value={moveValor}
                onChange={(e) => setMoveValor(e.target.value)}
              />
            </div>
            <div>
              <Label>Histórico</Label>
              <Input
                value={moveHistorico}
                onChange={(e) => setMoveHistorico(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitMovement} disabled={busy}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transferência */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transferência entre contas</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Origem</Label>
              <Select value={origemId} onValueChange={setOrigemId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Destino</Label>
              <Select value={destinoId} onValueChange={setDestinoId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Valor</Label>
              <Input
                type="number"
                step="0.01"
                value={transferValor}
                onChange={(e) => setTransferValor(e.target.value)}
              />
            </div>
            <div>
              <Label>Histórico</Label>
              <Input
                value={transferHistorico}
                onChange={(e) => setTransferHistorico(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitTransfer} disabled={busy}>
              Transferir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
