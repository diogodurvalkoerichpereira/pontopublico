import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ClipboardList,
  Plus,
  PackageMinus,
  CircleSlash,
  Ban,
  History,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import {
  getPriceRegistrations,
  createPriceRegistration,
  drawFromPriceRegistration,
  closePriceRegistration,
  getPriceRegistrationSummary,
  getPriceRegistrationDraws,
} from "@/lib/price-registration.functions";
import { getProcurementProcesses } from "@/lib/procurement.functions";

export const Route = createFileRoute("/atas")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("contracts.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Registration = {
  id: string;
  numero: string;
  ano: number;
  fornecedor: string;
  vigencia_inicio: string;
  vigencia_fim: string;
  status: string;
};
type Item = {
  id: string;
  registration_id: string;
  descricao: string;
  unidade: string;
  quantidade_registrada: string;
  quantidade_consumida: string;
  preco_unitario: string;
};

const hoje = () => new Date().toISOString().slice(0, 10);

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getPriceRegistrations);
  const loadProcesses = useServerFn(getProcurementProcesses);
  const create = useServerFn(createPriceRegistration);
  const draw = useServerFn(drawFromPriceRegistration);
  const close = useServerFn(closePriceRegistration);
  const loadSummary = useServerFn(getPriceRegistrationSummary);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    process_id: "",
    numero: "",
    fornecedor: "",
    vigencia_inicio: hoje(),
    vigencia_fim: hoje(),
    descricao: "",
    unidade: "un",
    quantidade: "",
    preco: "",
  });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const [drawItem, setDrawItem] = useState<Item | null>(null);
  const [drawQtd, setDrawQtd] = useState("");
  const [histAta, setHistAta] = useState<Registration | null>(null);
  const loadDraws = useServerFn(getPriceRegistrationDraws);
  const { data: histData } = useQuery({
    queryKey: ["price-registration-draws", activeTenant?.id, histAta?.id],
    enabled: Boolean(activeTenant && histAta),
    queryFn: () =>
      loadDraws({
        data: { tenant_id: activeTenant!.id, registration_id: histAta!.id },
      }),
  });

  const { data } = useQuery({
    queryKey: ["price-registrations", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: processData } = useQuery({
    queryKey: ["procurement-processes", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadProcesses({ data: { tenant_id: activeTenant!.id } }),
  });
  const { data: summary } = useQuery({
    queryKey: ["price-registration-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadSummary({ data: { tenant_id: activeTenant!.id } }),
  });

  const registrations = (data?.registrations ?? []) as Registration[];
  const items = (data?.items ?? []) as Item[];
  const canManage = data?.canManage ?? false;
  const homologadas = useMemo(
    () =>
      (
        (processData ?? []) as Array<{
          id: string;
          numero: string;
          ano: number;
          status: string;
        }>
      ).filter((p) => p.status === "homologada"),
    [processData],
  );

  const refresh = () => {
    qc.invalidateQueries({
      queryKey: ["price-registrations", activeTenant?.id],
    });
    qc.invalidateQueries({
      queryKey: ["price-registration-summary", activeTenant?.id],
    });
  };

  const brl = (n: number) =>
    n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const submitCreate = async () => {
    if (!activeTenant || !form.process_id) return;
    setBusy(true);
    try {
      await create({
        data: {
          tenant_id: activeTenant.id,
          procurement_process_id: form.process_id,
          numero: form.numero.trim(),
          ano: Number(form.vigencia_inicio.slice(0, 4)),
          fornecedor: form.fornecedor.trim(),
          vigencia_inicio: form.vigencia_inicio,
          vigencia_fim: form.vigencia_fim,
          itens: [
            {
              descricao: form.descricao.trim(),
              unidade: form.unidade.trim(),
              quantidade_registrada: Number(form.quantidade),
              preco_unitario: Number(form.preco),
            },
          ],
        },
      });
      toast.success("Ata registrada");
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao registrar",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitClose = async (
    ata: Registration,
    acao: "encerrar" | "cancelar",
  ) => {
    if (!activeTenant) return;
    const rotulo = acao === "encerrar" ? "Encerrar" : "Cancelar";
    if (
      !window.confirm(
        `${rotulo} a ata ${ata.numero}/${ata.ano}? A ação é definitiva e fecha novos consumos.`,
      )
    )
      return;
    setBusy(true);
    try {
      await close({
        data: {
          tenant_id: activeTenant.id,
          registration_id: ata.id,
          acao,
        },
      });
      toast.success(acao === "encerrar" ? "Ata encerrada" : "Ata cancelada");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha na ação");
    } finally {
      setBusy(false);
    }
  };

  const submitDraw = async () => {
    if (!activeTenant || !drawItem) return;
    setBusy(true);
    try {
      const r = await draw({
        data: {
          tenant_id: activeTenant.id,
          item_id: drawItem.id,
          quantidade: Number(drawQtd),
          data_referencia: hoje(),
        },
      });
      toast.success(`Consumido — saldo ${r.saldo}`);
      setDrawItem(null);
      setDrawQtd("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao consumir");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <ClipboardList className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Registro de Preços
            </h1>
            <p className="text-sm text-muted-foreground">
              Atas SRP (Lei 14.133) — itens, saldo e consumo
            </p>
          </div>
        </div>
        {canManage && (
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            disabled={homologadas.length === 0}
          >
            <Plus className="size-4" /> Nova ata
          </Button>
        )}
      </div>

      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">Atas vigentes</div>
            <div className="text-2xl font-bold tabular-nums">
              {summary.porStatus.vigente}
            </div>
            <div className="text-xs text-muted-foreground">
              {summary.porStatus.encerrada} encerradas ·{" "}
              {summary.porStatus.cancelada} canceladas
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">
              Valor registrado (vigentes)
            </div>
            <div className="text-2xl font-bold tabular-nums">
              {brl(summary.valorRegistrado)}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">Já consumido</div>
            <div className="text-2xl font-bold tabular-nums">
              {brl(summary.valorConsumido)}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-xs text-muted-foreground">
              Saldo a consumir
            </div>
            <div className="text-2xl font-bold tabular-nums text-primary">
              {brl(summary.saldoAConsumir)}
            </div>
          </div>
        </div>
      )}

      {registrations.map((ata) => (
        <div key={ata.id} className="rounded-xl border bg-card overflow-x-auto">
          <div className="flex items-center justify-between p-3 flex-wrap gap-2">
            <div className="font-bold">
              Ata {ata.numero}/{ata.ano} — {ata.fornecedor}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>
                {ata.vigencia_inicio} a {ata.vigencia_fim}
              </span>
              <Badge
                variant={ata.status === "vigente" ? "default" : "secondary"}
              >
                {ata.status}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setHistAta(ata)}
              >
                <History className="size-4" /> Histórico
              </Button>
              {canManage && ata.status === "vigente" && (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => submitClose(ata, "encerrar")}
                  >
                    <CircleSlash className="size-4" /> Encerrar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => submitClose(ata, "cancelar")}
                  >
                    <Ban className="size-4" /> Cancelar
                  </Button>
                </div>
              )}
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-semibold">Item</th>
                <th className="p-3 font-semibold">Un.</th>
                <th className="p-3 font-semibold text-right">Registrada</th>
                <th className="p-3 font-semibold text-right">Consumida</th>
                <th className="p-3 font-semibold text-right">Saldo</th>
                {canManage && <th className="p-3 font-semibold">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {items
                .filter((i) => i.registration_id === ata.id)
                .map((i) => {
                  const saldo =
                    Number(i.quantidade_registrada) -
                    Number(i.quantidade_consumida);
                  return (
                    <tr key={i.id} className="border-b last:border-0">
                      <td className="p-3">{i.descricao}</td>
                      <td className="p-3">{i.unidade}</td>
                      <td className="p-3 text-right tabular-nums">
                        {Number(i.quantidade_registrada)}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {Number(i.quantidade_consumida)}
                      </td>
                      <td className="p-3 text-right tabular-nums font-medium">
                        {saldo}
                      </td>
                      {canManage && (
                        <td className="p-3">
                          {ata.status === "vigente" && saldo > 0 && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setDrawItem(i);
                                setDrawQtd("");
                              }}
                            >
                              <PackageMinus className="size-4" /> Consumir
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ))}
      {registrations.length === 0 && (
        <div className="rounded-xl border bg-card p-6 text-center text-muted-foreground">
          Nenhuma ata registrada.
        </div>
      )}

      <Dialog
        open={Boolean(histAta)}
        onOpenChange={(o) => !o && setHistAta(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Histórico de consumos — ata {histAta?.numero}/{histAta?.ano}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th className="p-2">Data</th>
                  <th className="p-2">Item</th>
                  <th className="p-2 text-right">Qtd.</th>
                  <th className="p-2 text-right">Valor</th>
                </tr>
              </thead>
              <tbody>
                {(histData?.draws ?? []).map((d) => (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="p-2 tabular-nums">{d.data_referencia}</td>
                    <td className="p-2">{d.descricao}</td>
                    <td className="p-2 text-right tabular-nums">
                      {d.quantidade} {d.unidade}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {brl(d.valor)}
                    </td>
                  </tr>
                ))}
                {(histData?.draws ?? []).length === 0 && (
                  <tr>
                    <td className="p-3 text-muted-foreground" colSpan={4}>
                      Nenhum consumo registrado nesta ata.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {histData && (
            <p className="text-sm font-semibold">
              Total consumido: {brl(histData.totalConsumido)}
            </p>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova ata de registro de preços</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Licitação homologada</Label>
              <Select
                value={form.process_id}
                onValueChange={(v) => set("process_id", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a licitação" />
                </SelectTrigger>
                <SelectContent>
                  {homologadas.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.numero}/{p.ano}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Número da ata</Label>
                <Input
                  value={form.numero}
                  onChange={(e) => set("numero", e.target.value)}
                />
              </div>
              <div>
                <Label>Fornecedor</Label>
                <Input
                  value={form.fornecedor}
                  onChange={(e) => set("fornecedor", e.target.value)}
                />
              </div>
              <div>
                <Label>Vigência início</Label>
                <Input
                  type="date"
                  value={form.vigencia_inicio}
                  onChange={(e) => set("vigencia_inicio", e.target.value)}
                />
              </div>
              <div>
                <Label>Vigência fim</Label>
                <Input
                  type="date"
                  value={form.vigencia_fim}
                  onChange={(e) => set("vigencia_fim", e.target.value)}
                />
              </div>
            </div>
            <div className="border-t pt-3 grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <Label>Item — descrição</Label>
                <Input
                  value={form.descricao}
                  onChange={(e) => set("descricao", e.target.value)}
                />
              </div>
              <div>
                <Label>Unidade</Label>
                <Input
                  value={form.unidade}
                  onChange={(e) => set("unidade", e.target.value)}
                />
              </div>
              <div>
                <Label>Quantidade</Label>
                <Input
                  type="number"
                  value={form.quantidade}
                  onChange={(e) => set("quantidade", e.target.value)}
                />
              </div>
              <div>
                <Label>Preço unitário</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.preco}
                  onChange={(e) => set("preco", e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitCreate} disabled={busy || !form.process_id}>
              Registrar ata
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(drawItem)}
        onOpenChange={(o) => !o && setDrawItem(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Consumir — {drawItem?.descricao}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Saldo disponível:{" "}
              {drawItem
                ? Number(drawItem.quantidade_registrada) -
                  Number(drawItem.quantidade_consumida)
                : 0}{" "}
              {drawItem?.unidade}
            </p>
            <div>
              <Label>Quantidade a consumir</Label>
              <Input
                type="number"
                value={drawQtd}
                onChange={(e) => setDrawQtd(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitDraw} disabled={busy || !drawQtd}>
              Consumir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
