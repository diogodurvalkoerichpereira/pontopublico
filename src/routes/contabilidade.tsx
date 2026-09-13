import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import {
  getBalancete,
  getAccountLedger,
} from "@/lib/accounting-read.functions";

export const Route = createFileRoute("/contabilidade")({ component: Page });

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

type BalanceteRow = {
  conta: string;
  debito: string;
  credito: string;
  saldo: string;
};
type LedgerLine = {
  id: string;
  data_lancamento: string;
  historico: string;
  lado: string;
  valor: number;
  saldo: number;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function Content() {
  const { activeTenant } = useAuth();
  const loadBalancete = useServerFn(getBalancete);
  const loadLedger = useServerFn(getAccountLedger);
  const [ano, setAno] = useState(String(new Date().getFullYear()));
  const [conta, setConta] = useState<string | null>(null);

  const { data: balancete } = useQuery({
    queryKey: ["balancete", activeTenant?.id, ano],
    enabled: Boolean(activeTenant) && /^\d{4}$/.test(ano),
    queryFn: () =>
      loadBalancete({
        data: { tenant_id: activeTenant!.id, exercicio: Number(ano) },
      }),
  });
  const { data: ledger } = useQuery({
    queryKey: ["account-ledger", activeTenant?.id, ano, conta],
    enabled: Boolean(activeTenant) && Boolean(conta) && /^\d{4}$/.test(ano),
    queryFn: () =>
      loadLedger({
        data: {
          tenant_id: activeTenant!.id,
          exercicio: Number(ano),
          conta: conta!,
        },
      }),
  });

  const rows = (balancete?.contas ?? []) as BalanceteRow[];
  const totais = balancete?.totais;
  const conferido = balancete?.conferido ?? true;

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <BookOpen className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Contabilidade
            </h1>
            <p className="text-sm text-muted-foreground">
              Balancete e razão por conta (PCASP, Lei 4.320)
            </p>
          </div>
        </div>
        <div className="w-28">
          <Label>Exercício</Label>
          <Input
            type="number"
            value={ano}
            onChange={(e) => setAno(e.target.value)}
          />
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <div className="flex items-center justify-between p-3">
          <h2 className="font-bold">Balancete de verificação</h2>
          {totais && (
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                conferido
                  ? "bg-emerald-500/10 text-emerald-600"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {conferido
                ? "Confere (débitos = créditos)"
                : "Não confere (débitos ≠ créditos)"}
            </span>
          )}
        </div>
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Conta</th>
              <th className="p-3 font-semibold text-right">Débito</th>
              <th className="p-3 font-semibold text-right">Crédito</th>
              <th className="p-3 font-semibold text-right">Saldo</th>
              <th className="p-3 font-semibold">Razão</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.conta} className="border-b last:border-0">
                <td className="p-3 font-mono">{r.conta}</td>
                <td className="p-3 text-right tabular-nums">{brl(r.debito)}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(r.credito)}
                </td>
                <td className="p-3 text-right tabular-nums font-medium">
                  {brl(r.saldo)}
                </td>
                <td className="p-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConta(r.conta)}
                  >
                    Razão
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="p-6 text-center text-muted-foreground"
                >
                  Sem lançamentos no exercício.
                </td>
              </tr>
            )}
          </tbody>
          {totais && rows.length > 0 && (
            <tfoot className="border-t bg-muted/30 font-semibold">
              <tr>
                <td className="p-3">Totais</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(totais.debito)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(totais.credito)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(totais.saldo)}
                </td>
                <td className="p-3" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <Dialog open={Boolean(conta)} onOpenChange={(o) => !o && setConta(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Razão da conta {conta}</DialogTitle>
          </DialogHeader>
          {ledger && (
            <div className="mb-2 text-sm text-muted-foreground">
              Débito <b className="text-foreground">{brl(ledger.debito)}</b> ·
              Crédito <b className="text-foreground">{brl(ledger.credito)}</b> ·
              Saldo <b className="text-foreground">{brl(ledger.saldo)}</b>
            </div>
          )}
          <div className="max-h-80 overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-2 font-semibold">Data</th>
                  <th className="p-2 font-semibold">Histórico</th>
                  <th className="p-2 font-semibold">D/C</th>
                  <th className="p-2 font-semibold text-right">Valor</th>
                  <th className="p-2 font-semibold text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {((ledger?.linhas ?? []) as LedgerLine[]).map((l) => (
                  <tr key={l.id} className="border-b last:border-0">
                    <td className="p-2">{l.data_lancamento}</td>
                    <td className="p-2">{l.historico}</td>
                    <td className="p-2">{l.lado}</td>
                    <td className="p-2 text-right tabular-nums">
                      {brl(l.valor)}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {brl(l.saldo)}
                    </td>
                  </tr>
                ))}
                {(ledger?.linhas ?? []).length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="p-4 text-center text-muted-foreground"
                    >
                      Sem lançamentos.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
