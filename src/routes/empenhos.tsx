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
  getBudgetCommitments,
  transitionBudgetCommitment,
  partiallyCancelBudgetCommitment,
} from "@/lib/budget.functions";

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
  return <Content />;
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
  const qc = useQueryClient();
  const canManage = hasTenantPermission("budget.manage");

  const [pcTarget, setPcTarget] = useState<Commitment | null>(null);
  const [pcValor, setPcValor] = useState("");
  const [pcMotivo, setPcMotivo] = useState("");
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ["budget-commitments", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data ?? []) as Commitment[];

  const refresh = () =>
    qc.invalidateQueries({
      queryKey: ["budget-commitments", activeTenant?.id],
    });

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
      <div className="flex items-center gap-3">
        <ReceiptText className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Empenhos</h1>
          <p className="text-sm text-muted-foreground">
            Estágios da despesa (Lei 4.320): empenhado → liquidado → pago
          </p>
        </div>
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
    </section>
  );
}
