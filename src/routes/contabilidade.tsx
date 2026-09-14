import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BookOpen, Route as RouteIcon } from "lucide-react";
import { toast } from "sonner";
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
import {
  getAccountingEventAccounts,
  saveAccountingEventAccount,
} from "@/lib/accounting.functions";

// O2-06b — rótulos dos eventos contabilizáveis por roteiro.
const EVENTO_LABEL: Record<string, string> = {
  empenho: "Empenho",
  empenho_anulacao: "Anulação de empenho",
  liquidacao: "Liquidação",
  pagamento: "Pagamento",
  baixa_bem_depreciacao: "Baixa de bem — depreciação acumulada",
  baixa_bem_desincorporacao: "Baixa de bem — desincorporação (VPD)",
  baixa_bem_alienacao: "Baixa de bem — alienação (VPA)",
  reavaliacao_positiva: "Reavaliação de bem — ganho (VPA)",
  reavaliacao_negativa: "Reavaliação de bem — perda (VPD)",
};
type Roteiro = {
  event_code: string;
  debit_account: string | null;
  credit_account: string | null;
  configurado: boolean;
};

import { AppShell } from "@/components/AppShell";

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
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
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

  // O2-06b — roteiros contábeis (conta débito/crédito por evento).
  const qc = useQueryClient();
  const loadRoteiros = useServerFn(getAccountingEventAccounts);
  const saveRoteiro = useServerFn(saveAccountingEventAccount);
  const { data: roteirosData } = useQuery({
    queryKey: ["accounting-event-accounts", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadRoteiros({ data: { tenant_id: activeTenant!.id } }),
  });
  const roteiros = (roteirosData?.roteiros ?? []) as Roteiro[];
  const canManageRoteiros = roteirosData?.canManage ?? false;
  const [edicao, setEdicao] = useState<
    Record<string, { d: string; c: string }>
  >({});
  const [salvando, setSalvando] = useState<string | null>(null);
  const campo = (r: Roteiro) =>
    edicao[r.event_code] ?? {
      d: r.debit_account ?? "",
      c: r.credit_account ?? "",
    };
  const gravarRoteiro = async (r: Roteiro) => {
    if (!activeTenant) return;
    const v = campo(r);
    setSalvando(r.event_code);
    try {
      await saveRoteiro({
        data: {
          tenant_id: activeTenant.id,
          event_code: r.event_code as
            | "empenho"
            | "empenho_anulacao"
            | "liquidacao"
            | "pagamento"
            | "baixa_bem_depreciacao"
            | "baixa_bem_desincorporacao"
            | "baixa_bem_alienacao"
            | "reavaliacao_positiva"
            | "reavaliacao_negativa",
          debit_account: v.d.trim(),
          credit_account: v.c.trim(),
        },
      });
      toast.success(
        `Roteiro gravado: ${EVENTO_LABEL[r.event_code] ?? r.event_code}`,
      );
      qc.invalidateQueries({
        queryKey: ["accounting-event-accounts", activeTenant.id],
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao gravar");
    } finally {
      setSalvando(null);
    }
  };

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

      {/* O2-06b — Roteiros contábeis (O2-06): sem roteiro o fato não escritura */}
      <div className="rounded-xl border bg-card overflow-x-auto">
        <div className="p-3">
          <h2 className="font-bold flex items-center gap-2">
            <RouteIcon className="size-4" /> Roteiros contábeis
          </h2>
          <p className="text-xs text-muted-foreground">
            Conta de débito e de crédito por evento (PCASP). Evento sem roteiro
            não escritura automaticamente — o ente decide o roteiro.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Evento</th>
              <th className="p-3 font-semibold">Débito</th>
              <th className="p-3 font-semibold">Crédito</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManageRoteiros && <th className="p-3 font-semibold" />}
            </tr>
          </thead>
          <tbody>
            {roteiros.map((r) => (
              <tr key={r.event_code} className="border-b last:border-0">
                <td className="p-3 font-medium">
                  {EVENTO_LABEL[r.event_code] ?? r.event_code}
                </td>
                <td className="p-3">
                  {canManageRoteiros ? (
                    <Input
                      className="h-8 font-mono"
                      placeholder="ex.: 1.1.1.1"
                      value={campo(r).d}
                      onChange={(e) =>
                        setEdicao((m) => ({
                          ...m,
                          [r.event_code]: { ...campo(r), d: e.target.value },
                        }))
                      }
                    />
                  ) : (
                    <span className="font-mono">{r.debit_account ?? "—"}</span>
                  )}
                </td>
                <td className="p-3">
                  {canManageRoteiros ? (
                    <Input
                      className="h-8 font-mono"
                      placeholder="ex.: 2.1.1.1"
                      value={campo(r).c}
                      onChange={(e) =>
                        setEdicao((m) => ({
                          ...m,
                          [r.event_code]: { ...campo(r), c: e.target.value },
                        }))
                      }
                    />
                  ) : (
                    <span className="font-mono">{r.credit_account ?? "—"}</span>
                  )}
                </td>
                <td className="p-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      r.configurado
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {r.configurado ? "configurado" : "sem roteiro"}
                  </span>
                </td>
                {canManageRoteiros && (
                  <td className="p-3">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        salvando === r.event_code ||
                        !campo(r).d.trim() ||
                        !campo(r).c.trim()
                      }
                      onClick={() => gravarRoteiro(r)}
                    >
                      Gravar
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
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
