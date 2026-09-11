import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Boxes, Plus, ArrowDownUp } from "lucide-react";
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
} from "@/lib/materials.functions";

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
  saldo_quantidade: string;
  saldo_valor: string;
  status: string;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => new Date().toISOString().slice(0, 10);

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getMaterialItems);
  const saveItem = useServerFn(saveMaterialItem);
  const move = useServerFn(recordMaterialMovement);
  const qc = useQueryClient();

  const [itemOpen, setItemOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [codigo, setCodigo] = useState("");
  const [nome, setNome] = useState("");
  const [unidade, setUnidade] = useState("un");

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

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["material-items", activeTenant?.id] });

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
          status: "ativo",
        },
      });
      toast.success("Item cadastrado");
      setItemOpen(false);
      setCodigo("");
      setNome("");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
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

      <div className="rounded-xl border bg-card p-4">
        <div className="text-sm text-muted-foreground">
          Valor total em estoque
        </div>
        <div className="text-2xl font-bold">{brl(valorTotal)}</div>
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Código</th>
              <th className="p-3 font-semibold">Item</th>
              <th className="p-3 font-semibold">Un</th>
              <th className="p-3 font-semibold text-right">Qtd</th>
              <th className="p-3 font-semibold text-right">Valor</th>
              <th className="p-3 font-semibold">Situação</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{i.codigo}</td>
                <td className="p-3">{i.nome}</td>
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
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={6}
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
    </section>
  );
}
