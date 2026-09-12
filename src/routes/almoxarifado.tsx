import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Boxes,
  Plus,
  ArrowDownUp,
  ScrollText,
  Landmark,
  ClipboardCheck,
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
  getMaterialItems,
  saveMaterialItem,
  recordMaterialMovement,
  getMaterialInventory,
  getMaterialLedger,
  getMaterialMovementSummary,
  adjustMaterialInventory,
} from "@/lib/materials.functions";
import { incorporateMaterialAsset } from "@/lib/assets.functions";

export const Route = createFileRoute("/almoxarifado")({ component: Page });

function Page() {
  const { session, loading, hasTenantPermission } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasTenantPermission("materials.read")) nav({ to: "/app" });
  }, [session, loading, hasTenantPermission, nav]);
  if (!session) return null;
  return <Content />;
}

type Item = {
  id: string;
  codigo: string;
  nome: string;
  unidade: string;
  categoria: "consumo" | "permanente";
  saldo_quantidade: string;
  saldo_valor: string;
  status: string;
};

type InventoryLine = {
  categoria: "consumo" | "permanente";
  itens: number;
  saldo_quantidade: number;
  saldo_valor: number;
};

type LedgerMovement = {
  id: string;
  tipo: "entrada" | "saida";
  quantidade: number;
  valor_unitario: number;
  data_movimento: string;
  historico: string;
  saldo_quantidade: number;
};

const CATEGORIA_LABEL: Record<string, string> = {
  consumo: "Consumo",
  permanente: "Permanente",
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getMaterialItems);
  const saveItem = useServerFn(saveMaterialItem);
  const move = useServerFn(recordMaterialMovement);
  const loadInventory = useServerFn(getMaterialInventory);
  const loadLedger = useServerFn(getMaterialLedger);
  const incorporate = useServerFn(incorporateMaterialAsset);
  const loadMovSummary = useServerFn(getMaterialMovementSummary);
  const adjust = useServerFn(adjustMaterialInventory);
  const qc = useQueryClient();

  const [adjItem, setAdjItem] = useState<Item | null>(null);
  const [adjContada, setAdjContada] = useState("");
  const [adjHistorico, setAdjHistorico] = useState("");

  const monthStart = new Date().toISOString().slice(0, 8) + "01";
  const [periodo, setPeriodo] = useState({ from: monthStart, to: hoje() });

  const [itemOpen, setItemOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledgerItem, setLedgerItem] = useState<Item | null>(null);
  const [ledger, setLedger] = useState<LedgerMovement[]>([]);

  const [incOpen, setIncOpen] = useState(false);
  const [incItem, setIncItem] = useState<Item | null>(null);
  const [incForm, setIncForm] = useState({
    quantidade: "",
    tombamento: "",
    descricao: "",
    vida_util_meses: "60",
    valor_residual: "0",
  });
  const setInc = (k: keyof typeof incForm, v: string) =>
    setIncForm((f) => ({ ...f, [k]: v }));

  const [codigo, setCodigo] = useState("");
  const [nome, setNome] = useState("");
  const [unidade, setUnidade] = useState("un");
  const [categoria, setCategoria] = useState<"consumo" | "permanente">(
    "consumo",
  );

  const [moveItemId, setMoveItemId] = useState("");
  const [moveTipo, setMoveTipo] = useState<"entrada" | "saida">("entrada");
  const [quantidade, setQuantidade] = useState("");
  const [valorUnitario, setValorUnitario] = useState("");
  const [historico, setHistorico] = useState("");

  const { data } = useQuery({
    queryKey: ["material-items", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const items = (data?.items ?? []) as Item[];
  const canManage = data?.canManage ?? false;
  const valorTotal = items.reduce((s, i) => s + Number(i.saldo_valor), 0);

  const { data: inv } = useQuery({
    queryKey: ["material-inventory", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadInventory({ data: { tenant_id: activeTenant!.id } }),
  });
  const inventory = (inv?.categorias ?? []) as InventoryLine[];

  const { data: movSummary } = useQuery({
    queryKey: [
      "material-mov-summary",
      activeTenant?.id,
      periodo.from,
      periodo.to,
    ],
    enabled: Boolean(activeTenant),
    queryFn: () =>
      loadMovSummary({
        data: {
          tenant_id: activeTenant!.id,
          from: periodo.from,
          to: periodo.to,
        },
      }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["material-items", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["material-inventory", activeTenant?.id],
    });
    qc.invalidateQueries({
      queryKey: ["material-mov-summary", activeTenant?.id],
    });
  };

  const openAdjust = (item: Item) => {
    setAdjItem(item);
    setAdjContada(item.saldo_quantidade);
    setAdjHistorico("");
  };

  const submitAdjust = async () => {
    if (!activeTenant || !adjItem) return;
    setBusy(true);
    try {
      const r = await adjust({
        data: {
          tenant_id: activeTenant.id,
          item_id: adjItem.id,
          quantidade_contada: Number(adjContada),
          data_ajuste: hoje(),
          historico: adjHistorico.trim(),
        },
      });
      toast.success(`Ajuste de ${r.tipo} — saldo: ${r.saldo_quantidade} un`);
      setAdjItem(null);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha no ajuste");
    } finally {
      setBusy(false);
    }
  };

  const submitItem = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await saveItem({
        data: {
          tenant_id: activeTenant.id,
          codigo: codigo.trim(),
          nome: nome.trim(),
          unidade: unidade.trim(),
          categoria,
          status: "ativo",
        },
      });
      toast.success("Item cadastrado");
      setItemOpen(false);
      setCodigo("");
      setNome("");
      setCategoria("consumo");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const openLedger = async (item: Item) => {
    if (!activeTenant) return;
    setLedgerItem(item);
    setLedger([]);
    setLedgerOpen(true);
    try {
      const r = await loadLedger({
        data: { tenant_id: activeTenant.id, item_id: item.id },
      });
      setLedger(r.movimentos as LedgerMovement[]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha na razão");
    }
  };

  const openIncorporate = (item: Item) => {
    setIncItem(item);
    setIncForm({
      quantidade: "",
      tombamento: "",
      descricao: item.nome,
      vida_util_meses: "60",
      valor_residual: "0",
    });
    setIncOpen(true);
  };

  const submitIncorporate = async () => {
    if (!activeTenant || !incItem) return;
    setBusy(true);
    try {
      const r = await incorporate({
        data: {
          tenant_id: activeTenant.id,
          item_id: incItem.id,
          quantidade: Number(incForm.quantidade),
          tombamento: incForm.tombamento.trim(),
          descricao: incForm.descricao.trim() || undefined,
          vida_util_meses: Number(incForm.vida_util_meses),
          valor_residual: Number(incForm.valor_residual || 0),
          data_aquisicao: hoje(),
        },
      });
      toast.success(`Bem incorporado — ${brl(r.valor_aquisicao)}`);
      setIncOpen(false);
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao incorporar",
      );
    } finally {
      setBusy(false);
    }
  };

  const submitMove = async () => {
    if (!activeTenant || !moveItemId) return;
    setBusy(true);
    try {
      const r = await move({
        data: {
          tenant_id: activeTenant.id,
          item_id: moveItemId,
          tipo: moveTipo,
          quantidade: Number(quantidade),
          valor_unitario: Number(valorUnitario || 0),
          data_movimento: hoje(),
          historico: historico.trim(),
        },
      });
      toast.success(`Saldo: ${r.saldo_quantidade} un / ${brl(r.saldo_valor)}`);
      setMoveOpen(false);
      setQuantidade("");
      setValorUnitario("");
      setHistorico("");
      refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha no movimento",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Boxes className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Almoxarifado
            </h1>
            <p className="text-sm text-muted-foreground">
              Itens de estoque — saldo em quantidade e valor (custo médio)
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={() => setItemOpen(true)}>
              <Plus className="size-4" /> Novo item
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setMoveItemId(items[0]?.id ?? "");
                setMoveOpen(true);
              }}
              disabled={items.length === 0}
            >
              <ArrowDownUp className="size-4" /> Movimento
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm text-muted-foreground">
            Valor total em estoque
          </div>
          <div className="text-2xl font-bold">{brl(valorTotal)}</div>
        </div>
        {inventory.map((c) => (
          <div key={c.categoria} className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              {CATEGORIA_LABEL[c.categoria] ?? c.categoria} — {c.itens}{" "}
              {c.itens === 1 ? "item" : "itens"}
            </div>
            <div className="text-2xl font-bold">{brl(c.saldo_valor)}</div>
            <div className="text-xs text-muted-foreground">
              {c.saldo_quantidade} un
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <Label>De</Label>
            <Input
              type="date"
              value={periodo.from}
              onChange={(e) =>
                setPeriodo((p) => ({ ...p, from: e.target.value }))
              }
            />
          </div>
          <div>
            <Label>Até</Label>
            <Input
              type="date"
              value={periodo.to}
              onChange={(e) =>
                setPeriodo((p) => ({ ...p, to: e.target.value }))
              }
            />
          </div>
          <div className="text-sm text-muted-foreground">
            Movimentação do período
          </div>
        </div>
        {movSummary && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <div className="text-sm text-muted-foreground">
                Entradas ({movSummary.entradas.movimentos})
              </div>
              <div className="text-lg font-bold">
                {brl(movSummary.entradas.valor)}
              </div>
              <div className="text-xs text-muted-foreground">
                {movSummary.entradas.quantidade} un
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-sm text-muted-foreground">
                Saídas ({movSummary.saidas.movimentos})
              </div>
              <div className="text-lg font-bold">
                {brl(movSummary.saidas.valor)}
              </div>
              <div className="text-xs text-muted-foreground">
                {movSummary.saidas.quantidade} un
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Código</th>
              <th className="p-3 font-semibold">Item</th>
              <th className="p-3 font-semibold">Categoria</th>
              <th className="p-3 font-semibold">Un</th>
              <th className="p-3 font-semibold text-right">Qtd</th>
              <th className="p-3 font-semibold text-right">Valor</th>
              <th className="p-3 font-semibold">Situação</th>
              <th className="p-3 font-semibold text-right">Razão</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{i.codigo}</td>
                <td className="p-3">{i.nome}</td>
                <td className="p-3">
                  <Badge variant="secondary">
                    {CATEGORIA_LABEL[i.categoria] ?? i.categoria}
                  </Badge>
                </td>
                <td className="p-3">{i.unidade}</td>
                <td className="p-3 text-right tabular-nums">
                  {i.saldo_quantidade}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {brl(i.saldo_valor)}
                </td>
                <td className="p-3">
                  <Badge
                    variant={i.status === "ativo" ? "default" : "secondary"}
                  >
                    {i.status}
                  </Badge>
                </td>
                <td className="p-3 text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openLedger(i)}
                    >
                      <ScrollText className="size-4" />
                    </Button>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Ajustar inventário"
                        onClick={() => openAdjust(i)}
                      >
                        <ClipboardCheck className="size-4" />
                      </Button>
                    )}
                    {canManage &&
                      i.categoria === "permanente" &&
                      Number(i.saldo_quantidade) > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Incorporar ao patrimônio"
                          onClick={() => openIncorporate(i)}
                        >
                          <Landmark className="size-4" />
                        </Button>
                      )}
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum item cadastrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Novo item */}
      <Dialog open={itemOpen} onOpenChange={setItemOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo item</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Código</Label>
              <Input
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
              />
            </div>
            <div>
              <Label>Nome</Label>
              <Input value={nome} onChange={(e) => setNome(e.target.value)} />
            </div>
            <div>
              <Label>Unidade</Label>
              <Input
                value={unidade}
                onChange={(e) => setUnidade(e.target.value)}
              />
            </div>
            <div>
              <Label>Categoria</Label>
              <Select
                value={categoria}
                onValueChange={(v) =>
                  setCategoria(v as "consumo" | "permanente")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="consumo">Consumo</SelectItem>
                  <SelectItem value="permanente">Permanente</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitItem} disabled={busy}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Movimento */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Movimentar estoque</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Item</Label>
              <Select value={moveItemId} onValueChange={setMoveItemId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {items.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.codigo} — {i.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tipo</Label>
              <Select
                value={moveTipo}
                onValueChange={(v) => setMoveTipo(v as "entrada" | "saida")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="entrada">Entrada</SelectItem>
                  <SelectItem value="saida">Saída</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Quantidade</Label>
                <Input
                  type="number"
                  step="0.001"
                  value={quantidade}
                  onChange={(e) => setQuantidade(e.target.value)}
                />
              </div>
              <div>
                <Label>Valor unitário</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={valorUnitario}
                  onChange={(e) => setValorUnitario(e.target.value)}
                  disabled={moveTipo === "saida"}
                />
              </div>
            </div>
            <div>
              <Label>Histórico</Label>
              <Input
                value={historico}
                onChange={(e) => setHistorico(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitMove} disabled={busy}>
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ajuste de inventário */}
      <Dialog
        open={Boolean(adjItem)}
        onOpenChange={(o) => !o && setAdjItem(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Ajuste de inventário — {adjItem?.codigo} {adjItem?.nome}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Saldo no sistema: {adjItem?.saldo_quantidade} un. Informe a
              quantidade contada; a diferença gera um ajuste ao custo médio.
            </p>
            <div>
              <Label>Quantidade contada</Label>
              <Input
                type="number"
                step="0.001"
                value={adjContada}
                onChange={(e) => setAdjContada(e.target.value)}
              />
            </div>
            <div>
              <Label>Histórico</Label>
              <Input
                value={adjHistorico}
                onChange={(e) => setAdjHistorico(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitAdjust}
              disabled={
                busy || adjContada === "" || adjHistorico.trim().length < 3
              }
            >
              Ajustar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Incorporar ao patrimônio */}
      <Dialog open={incOpen} onOpenChange={setIncOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Incorporar ao patrimônio — {incItem?.codigo} {incItem?.nome}
            </DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Quantidade</Label>
              <Input
                type="number"
                step="0.001"
                value={incForm.quantidade}
                onChange={(e) => setInc("quantidade", e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Saldo: {incItem?.saldo_quantidade} un
              </p>
            </div>
            <div>
              <Label>Tombamento</Label>
              <Input
                value={incForm.tombamento}
                onChange={(e) => setInc("tombamento", e.target.value)}
              />
            </div>
            <div className="col-span-2">
              <Label>Descrição do bem</Label>
              <Input
                value={incForm.descricao}
                onChange={(e) => setInc("descricao", e.target.value)}
              />
            </div>
            <div>
              <Label>Vida útil (meses)</Label>
              <Input
                type="number"
                value={incForm.vida_util_meses}
                onChange={(e) => setInc("vida_util_meses", e.target.value)}
              />
            </div>
            <div>
              <Label>Valor residual</Label>
              <Input
                type="number"
                step="0.01"
                value={incForm.valor_residual}
                onChange={(e) => setInc("valor_residual", e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitIncorporate}
              disabled={
                busy || !incForm.quantidade || !incForm.tombamento.trim()
              }
            >
              Incorporar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Razão (kardex) */}
      <Dialog open={ledgerOpen} onOpenChange={setLedgerOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Razão — {ledgerItem?.codigo} {ledgerItem?.nome}
            </DialogTitle>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="p-2 font-semibold">Data</th>
                  <th className="p-2 font-semibold">Histórico</th>
                  <th className="p-2 font-semibold">Tipo</th>
                  <th className="p-2 font-semibold text-right">Qtd</th>
                  <th className="p-2 font-semibold text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="p-2">{m.data_movimento}</td>
                    <td className="p-2">{m.historico}</td>
                    <td className="p-2">
                      <Badge
                        variant={m.tipo === "entrada" ? "default" : "secondary"}
                      >
                        {m.tipo}
                      </Badge>
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {m.tipo === "saida" ? "−" : "+"}
                      {m.quantidade}
                    </td>
                    <td className="p-2 text-right tabular-nums font-medium">
                      {m.saldo_quantidade}
                    </td>
                  </tr>
                ))}
                {ledger.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="p-6 text-center text-muted-foreground"
                    >
                      Sem movimentação.
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
