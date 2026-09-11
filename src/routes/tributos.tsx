import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Landmark, Home, HandCoins, FileWarning } from "lucide-react";
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
  getTaxCredits,
  recordTaxPayment,
  inscribeDividaAtiva,
} from "@/lib/taxes.functions";
import { getProperties, launchIptu } from "@/lib/real-estate.functions";

export const Route = createFileRoute("/tributos")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("taxes.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Credit = {
  id: string;
  tributo: string;
  exercicio: number;
  contribuinte: string;
  inscricao: string;
  valor_lancado: string;
  valor_pago: string;
  saldo: string;
  vencimento: string;
  status: string;
};
type Property = {
  id: string;
  inscricao_imobiliaria: string;
  proprietario: string;
  valor_venal: string;
  status: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);
const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  lancado: "secondary",
  divida_ativa: "destructive",
  quitado: "default",
  cancelado: "outline",
};

function Content() {
  const { activeTenant } = useAuth();
  const loadCredits = useServerFn(getTaxCredits);
  const loadProps = useServerFn(getProperties);
  const pay = useServerFn(recordTaxPayment);
  const inscribe = useServerFn(inscribeDividaAtiva);
  const launch = useServerFn(launchIptu);
  const qc = useQueryClient();

  const [payOpen, setPayOpen] = useState(false);
  const [payCredit, setPayCredit] = useState<Credit | null>(null);
  const [payValor, setPayValor] = useState("");

  const [iptuOpen, setIptuOpen] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [exercicio, setExercicio] = useState(String(new Date().getFullYear()));
  const [aliquota, setAliquota] = useState("1");
  const [vencimento, setVencimento] = useState(hoje());

  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ["tax-credits", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadCredits({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: propsData } = useQuery({
    queryKey: ["properties", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadProps({ data: { tenant_id: activeTenant!.id } }),
  });

  const credits = (data?.credits ?? []) as Credit[];
  const canManage = data?.canManage ?? false;
  const properties = (propsData?.properties ?? []) as Property[];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tax-credits", activeTenant?.id] });
  };

  const openPay = (c: Credit) => {
    setPayCredit(c);
    setPayValor(c.saldo);
    setPayOpen(true);
  };

  const submitPay = async () => {
    if (!activeTenant || !payCredit) return;
    setBusy(true);
    try {
      await pay({
        data: {
          tenant_id: activeTenant.id,
          credit_id: payCredit.id,
          data_pagamento: hoje(),
          valor: Number(payValor),
        },
      });
      toast.success("Arrecadação registrada");
      setPayOpen(false);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao arrecadar",
      );
    } finally {
      setBusy(false);
    }
  };

  const doInscribe = async (c: Credit) => {
    if (!activeTenant) return;
    try {
      await inscribe({
        data: {
          tenant_id: activeTenant.id,
          credit_id: c.id,
          data_referencia: hoje(),
        },
      });
      toast.success("Inscrito em dívida ativa");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao inscrever",
      );
    }
  };

  const submitIptu = async () => {
    if (!activeTenant || !propertyId) return;
    setBusy(true);
    try {
      const r = await launch({
        data: {
          tenant_id: activeTenant.id,
          property_id: propertyId,
          exercicio: Number(exercicio),
          aliquota: Number(aliquota),
          vencimento,
        },
      });
      toast.success(`IPTU lançado: ${brl(r.valor)}`);
      setIptuOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao lançar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Landmark className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Tributos</h1>
            <p className="text-sm text-muted-foreground">
              Créditos tributários, arrecadação e dívida ativa
            </p>
          </div>
        </div>
        {canManage && (
          <Button
            variant="outline"
            onClick={() => {
              setPropertyId(properties[0]?.id ?? "");
              setIptuOpen(true);
            }}
            disabled={properties.length === 0}
          >
            <Home className="size-4" /> Lançar IPTU
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Tributo</th>
              <th className="p-3 font-semibold">Exerc.</th>
              <th className="p-3 font-semibold">Contribuinte</th>
              <th className="p-3 font-semibold">Inscrição</th>
              <th className="p-3 font-semibold text-right">Saldo</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {credits.map((c) => (
              <tr key={c.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{c.tributo}</td>
                <td className="p-3">{c.exercicio}</td>
                <td className="p-3">{c.contribuinte}</td>
                <td className="p-3 text-muted-foreground">{c.inscricao}</td>
                <td className="p-3 text-right tabular-nums">{brl(c.saldo)}</td>
                <td className="p-3">
                  <Badge variant={statusVariant[c.status] ?? "secondary"}>
                    {c.status.replace("_", " ")}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3">
                    <div className="flex gap-2">
                      {c.status !== "quitado" && c.status !== "cancelado" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openPay(c)}
                        >
                          <HandCoins className="size-4" /> Arrecadar
                        </Button>
                      )}
                      {c.status === "lancado" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doInscribe(c)}
                        >
                          <FileWarning className="size-4" /> Dívida ativa
                        </Button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {credits.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 7 : 6}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum crédito tributário lançado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Arrecadar */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Arrecadar tributo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {payCredit?.tributo} {payCredit?.exercicio} — saldo{" "}
              {payCredit ? brl(payCredit.saldo) : ""}
            </p>
            <div>
              <Label>Valor</Label>
              <Input
                type="number"
                step="0.01"
                value={payValor}
                onChange={(e) => setPayValor(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitPay} disabled={busy}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lançar IPTU */}
      <Dialog open={iptuOpen} onOpenChange={setIptuOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lançar IPTU</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Imóvel</Label>
              <Select value={propertyId} onValueChange={setPropertyId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {properties.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.inscricao_imobiliaria} — {p.proprietario} (
                      {brl(p.valor_venal)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Exercício</Label>
                <Input
                  type="number"
                  value={exercicio}
                  onChange={(e) => setExercicio(e.target.value)}
                />
              </div>
              <div>
                <Label>Alíquota (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={aliquota}
                  onChange={(e) => setAliquota(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>Vencimento</Label>
              <Input
                type="date"
                value={vencimento}
                onChange={(e) => setVencimento(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitIptu} disabled={busy}>
              Lançar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
