import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building, Plus, TrendingDown, Archive } from "lucide-react";
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
  getAssets,
  saveAsset,
  depreciateAsset,
  depreciateAllAssets,
  disposeAsset,
  getPatrimonySummary,
} from "@/lib/assets.functions";

export const Route = createFileRoute("/patrimonio")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("assets.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Asset = {
  id: string;
  tombamento: string;
  descricao: string;
  valor_aquisicao: string;
  valor_residual: string;
  vida_util_meses: number;
  meses_depreciados: number;
  depreciacao_acumulada: string;
  valor_liquido: string;
  status: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getAssets);
  const save = useServerFn(saveAsset);
  const depreciate = useServerFn(depreciateAsset);
  const depreciateAll = useServerFn(depreciateAllAssets);
  const dispose = useServerFn(disposeAsset);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [disposeTarget, setDisposeTarget] = useState<Asset | null>(null);
  const [disposeForm, setDisposeForm] = useState({ motivo: "", valor: "0" });
  const [form, setForm] = useState({
    tombamento: "",
    descricao: "",
    valor_aquisicao: "",
    valor_residual: "0",
    vida_util_meses: "60",
    data_aquisicao: "",
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const { data } = useQuery({
    queryKey: ["assets", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const assets = (data?.assets ?? []) as Asset[];
  const canManage = data?.canManage ?? false;

  const loadSummary = useServerFn(getPatrimonySummary);
  const { data: summary } = useQuery({
    queryKey: ["patrimony-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadSummary({ data: { tenant_id: activeTenant!.id } }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["assets", activeTenant?.id] });
    qc.invalidateQueries({ queryKey: ["patrimony-summary", activeTenant?.id] });
  };

  const runDepreciateAll = async () => {
    if (!activeTenant) return;
    if (
      !window.confirm(
        "Rodar a depreciação de 1 mês para todos os bens ativos com vida útil restante?",
      )
    )
      return;
    setBusy(true);
    try {
      const r = await depreciateAll({
        data: { tenant_id: activeTenant.id, meses: 1 },
      });
      toast.success(
        `Depreciados ${r.depreciados} bens — cota do mês ${brl(r.total_cota)}`,
      );
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao depreciar",
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await save({
        data: {
          tenant_id: activeTenant.id,
          tombamento: form.tombamento.trim(),
          descricao: form.descricao.trim(),
          valor_aquisicao: Number(form.valor_aquisicao),
          valor_residual: Number(form.valor_residual || 0),
          vida_util_meses: Number(form.vida_util_meses),
          data_aquisicao: form.data_aquisicao,
          status: "ativo",
        },
      });
      toast.success("Bem cadastrado");
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const doDepreciate = async (a: Asset, meses: number) => {
    if (!activeTenant) return;
    try {
      await depreciate({
        data: { tenant_id: activeTenant.id, asset_id: a.id, meses },
      });
      toast.success("Depreciação registrada");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao depreciar",
      );
    }
  };

  const openDispose = (a: Asset) => {
    setDisposeTarget(a);
    setDisposeForm({ motivo: "", valor: "0" });
  };

  const submitDispose = async () => {
    if (!activeTenant || !disposeTarget) return;
    setBusy(true);
    try {
      const r = await dispose({
        data: {
          tenant_id: activeTenant.id,
          asset_id: disposeTarget.id,
          data_baixa: new Date().toISOString().slice(0, 10),
          motivo: disposeForm.motivo.trim(),
          valor_alienacao: Number(disposeForm.valor || 0),
        },
      });
      toast.success(
        `Bem baixado — resultado ${brl(r.resultado)} (${
          r.resultado >= 0 ? "ganho" : "perda"
        })`,
      );
      setDisposeTarget(null);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao baixar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Building className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Patrimônio
            </h1>
            <p className="text-sm text-muted-foreground">
              Bens permanentes e depreciação linear (NBC TSP)
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={runDepreciateAll}
              disabled={busy}
            >
              <TrendingDown className="size-4" /> Depreciar mês (lote)
            </Button>
            <Button variant="outline" onClick={() => setOpen(true)}>
              <Plus className="size-4" /> Novo bem
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">
            Valor de aquisição
          </div>
          <div className="text-xl font-bold">
            {brl(summary?.valorAquisicao ?? 0)}
          </div>
          <div className="text-xs text-muted-foreground">
            {summary?.ativos ?? 0} bens ativos
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">
            Depreciação acumulada
          </div>
          <div className="text-xl font-bold">
            {brl(summary?.depreciacaoAcumulada ?? 0)}
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">
            Valor líquido contábil
          </div>
          <div className="text-xl font-bold">
            {brl(summary?.valorLiquido ?? 0)}
          </div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">Baixados</div>
          <div className="text-xl font-bold">{summary?.baixados ?? 0}</div>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Tombamento</th>
              <th className="p-3 font-semibold">Descrição</th>
              <th className="p-3 font-semibold text-right">Aquisição</th>
              <th className="p-3 font-semibold text-right">Depreciado</th>
              <th className="p-3 font-semibold text-right">Líquido</th>
              <th className="p-3 font-semibold">Vida útil</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{a.tombamento}</td>
                <td className="p-3">{a.descricao}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(a.valor_aquisicao)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(a.depreciacao_acumulada)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(a.valor_liquido)}
                </td>
                <td className="p-3 tabular-nums text-muted-foreground">
                  {a.meses_depreciados}/{a.vida_util_meses} m
                </td>
                {canManage && (
                  <td className="p-3">
                    {a.status === "ativo" ? (
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => doDepreciate(a, 1)}
                        >
                          <TrendingDown className="size-4" /> Depreciar mês
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openDispose(a)}
                        >
                          <Archive className="size-4" /> Baixar
                        </Button>
                      </div>
                    ) : (
                      <Badge variant="secondary">baixado</Badge>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {assets.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 7 : 6}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum bem cadastrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo bem</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Tombamento</Label>
              <Input
                value={form.tombamento}
                onChange={(e) => set("tombamento", e.target.value)}
              />
            </div>
            <div className="col-span-2">
              <Label>Descrição</Label>
              <Input
                value={form.descricao}
                onChange={(e) => set("descricao", e.target.value)}
              />
            </div>
            <div>
              <Label>Valor de aquisição</Label>
              <Input
                type="number"
                step="0.01"
                value={form.valor_aquisicao}
                onChange={(e) => set("valor_aquisicao", e.target.value)}
              />
            </div>
            <div>
              <Label>Valor residual</Label>
              <Input
                type="number"
                step="0.01"
                value={form.valor_residual}
                onChange={(e) => set("valor_residual", e.target.value)}
              />
            </div>
            <div>
              <Label>Vida útil (meses)</Label>
              <Input
                type="number"
                value={form.vida_util_meses}
                onChange={(e) => set("vida_util_meses", e.target.value)}
              />
            </div>
            <div>
              <Label>Data de aquisição</Label>
              <Input
                type="date"
                value={form.data_aquisicao}
                onChange={(e) => set("data_aquisicao", e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submit} disabled={busy}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(disposeTarget)}
        onOpenChange={(o) => !o && setDisposeTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Baixar bem {disposeTarget?.tombamento}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Valor líquido contábil: {brl(disposeTarget?.valor_liquido ?? 0)}.
              O resultado da baixa = alienação − líquido.
            </p>
            <div>
              <Label>Motivo</Label>
              <Input
                value={disposeForm.motivo}
                onChange={(e) =>
                  setDisposeForm((f) => ({ ...f, motivo: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Valor de alienação (0 se desfazimento)</Label>
              <Input
                type="number"
                step="0.01"
                value={disposeForm.valor}
                onChange={(e) =>
                  setDisposeForm((f) => ({ ...f, valor: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitDispose} disabled={busy}>
              Confirmar baixa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
