import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileSignature, Banknote } from "lucide-react";
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
import { getBankOrders, emitBankOrder } from "@/lib/bank-orders.functions";
import { getBudgetCommitments } from "@/lib/budget.functions";
import { getTreasuryAccounts } from "@/lib/treasury.functions";

export const Route = createFileRoute("/ordens-bancarias")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("accounting.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Order = {
  id: string;
  exercicio: number;
  numero: string;
  commitment_id: string;
  account_id: string;
  credor: string;
  valor: string;
  data_emissao: string;
  status: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);

function Content() {
  const { activeTenant } = useAuth();
  const loadOrders = useServerFn(getBankOrders);
  const loadCommitments = useServerFn(getBudgetCommitments);
  const loadAccounts = useServerFn(getTreasuryAccounts);
  const emit = useServerFn(emitBankOrder);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commitmentId, setCommitmentId] = useState("");
  const [accountId, setAccountId] = useState("");

  const { data: ordersData } = useQuery({
    queryKey: ["bank-orders", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadOrders({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: commitments } = useQuery({
    queryKey: ["budget-commitments", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadCommitments({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: accountsData } = useQuery({
    queryKey: ["treasury-accounts", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadAccounts({ data: { tenant_id: activeTenant!.id } }),
  });

  const orders = (ordersData?.orders ?? []) as Order[];
  const canManage = ordersData?.canManage ?? false;
  // Só empenhos liquidados podem ser pagos por OB (Lei 4.320).
  const liquidados = useMemo(
    () => (commitments ?? []).filter((c) => c.status === "liquidado"),
    [commitments],
  );
  const accounts = (accountsData?.accounts ?? []).filter(
    (a) => a.status === "ativa",
  );

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["bank-orders", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["budget-commitments", activeTenant?.id],
    });
    qc.invalidateQueries({ queryKey: ["treasury-accounts", activeTenant?.id] });
  };

  const openDialog = () => {
    setCommitmentId(liquidados[0]?.id ?? "");
    setAccountId(accounts[0]?.id ?? "");
    setOpen(true);
  };

  const submit = async () => {
    if (!activeTenant || !commitmentId || !accountId) return;
    setBusy(true);
    try {
      const r = await emit({
        data: {
          tenant_id: activeTenant.id,
          commitment_id: commitmentId,
          account_id: accountId,
          data_emissao: hoje(),
        },
      });
      toast.success(`OB nº ${r.numero} emitida — ${brl(r.valor)}`);
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao emitir");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <FileSignature className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Ordens bancárias
            </h1>
            <p className="text-sm text-muted-foreground">
              Pagamento de empenho liquidado pela tesouraria (Lei 4.320)
            </p>
          </div>
        </div>
        {canManage && (
          <Button onClick={openDialog} disabled={liquidados.length === 0}>
            <Banknote className="size-4" /> Emitir OB
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Nº</th>
              <th className="p-3 font-semibold">Exercício</th>
              <th className="p-3 font-semibold">Emissão</th>
              <th className="p-3 font-semibold">Credor</th>
              <th className="p-3 font-semibold text-right">Valor</th>
              <th className="p-3 font-semibold">Situação</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-b last:border-0">
                <td className="p-3 font-medium tabular-nums">{o.numero}</td>
                <td className="p-3">{o.exercicio}</td>
                <td className="p-3">{o.data_emissao}</td>
                <td className="p-3">{o.credor}</td>
                <td className="p-3 text-right tabular-nums">{brl(o.valor)}</td>
                <td className="p-3">
                  <Badge
                    variant={o.status === "paga" ? "default" : "secondary"}
                  >
                    {o.status}
                  </Badge>
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhuma ordem bancária emitida.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Emitir ordem bancária</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Empenho liquidado</Label>
              <Select value={commitmentId} onValueChange={setCommitmentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o empenho" />
                </SelectTrigger>
                <SelectContent>
                  {liquidados.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      nº {c.numero} — {c.credor} ({brl(c.valor)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Conta de tesouraria</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a conta" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.nome} ({brl(a.saldo_atual)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submit}
              disabled={busy || !commitmentId || !accountId}
            >
              Emitir e pagar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
