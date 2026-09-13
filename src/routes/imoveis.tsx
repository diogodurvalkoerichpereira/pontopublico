import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Home, Plus, Pencil, ShieldCheck } from "lucide-react";
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
  getProperties,
  getRealEstateSummary,
  savePropertyRegistration,
  setPropertyTaxBenefit,
} from "@/lib/real-estate.functions";

// O4-04d — Cadastro imobiliário (base do IPTU). Lista, cadastra e edita imóveis
// (inscrição, proprietário, endereço, valor venal, áreas, situação) e concede/encerra
// imunidade ou isenção de IPTU (O4-04c). O lançamento do IPTU segue em /tributos.
export const Route = createFileRoute("/imoveis")({ component: Page });

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

type Property = {
  id: string;
  inscricao_imobiliaria: string;
  proprietario: string;
  proprietario_documento: string;
  endereco: string;
  valor_venal: string;
  area_terreno: string | null;
  area_construida: string | null;
  status: string;
  beneficio_iptu: string | null;
  beneficio_iptu_motivo: string | null;
};

const brl = (v: number | string) =>
  Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const emptyForm = {
  id: "",
  inscricao_imobiliaria: "",
  proprietario: "",
  proprietario_documento: "",
  endereco: "",
  valor_venal: "",
  area_terreno: "",
  area_construida: "",
  status: "ativo",
};

function Content() {
  const { activeTenant } = useAuth();
  const load = useServerFn(getProperties);
  const loadSummary = useServerFn(getRealEstateSummary);
  const save = useServerFn(savePropertyRegistration);
  const setBenefit = useServerFn(setPropertyTaxBenefit);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const [benefitTarget, setBenefitTarget] = useState<Property | null>(null);
  const [beneficio, setBeneficio] = useState("imunidade");
  const [motivo, setMotivo] = useState("");

  const { data } = useQuery({
    queryKey: ["properties", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => load({ data: { tenant_id: activeTenant!.id } }),
  });
  const properties = (data?.properties ?? []) as Property[];
  const canManage = data?.canManage ?? false;

  const { data: summary } = useQuery({
    queryKey: ["real-estate-summary", activeTenant?.id],
    enabled: Boolean(activeTenant),
    queryFn: () => loadSummary({ data: { tenant_id: activeTenant!.id } }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["properties", activeTenant?.id] });
    qc.invalidateQueries({
      queryKey: ["real-estate-summary", activeTenant?.id],
    });
  };

  const openNew = () => {
    setForm({ ...emptyForm });
    setOpen(true);
  };
  const openEdit = (p: Property) => {
    setForm({
      id: p.id,
      inscricao_imobiliaria: p.inscricao_imobiliaria,
      proprietario: p.proprietario,
      proprietario_documento: p.proprietario_documento,
      endereco: p.endereco,
      valor_venal: p.valor_venal,
      area_terreno: p.area_terreno ?? "",
      area_construida: p.area_construida ?? "",
      status: p.status,
    });
    setOpen(true);
  };

  const submit = async () => {
    if (!activeTenant) return;
    setBusy(true);
    try {
      await save({
        data: {
          tenant_id: activeTenant.id,
          ...(form.id ? { id: form.id } : {}),
          inscricao_imobiliaria: form.inscricao_imobiliaria.trim(),
          proprietario: form.proprietario.trim(),
          proprietario_documento: form.proprietario_documento.trim(),
          endereco: form.endereco.trim(),
          valor_venal: Number(form.valor_venal),
          area_terreno: form.area_terreno ? Number(form.area_terreno) : null,
          area_construida: form.area_construida
            ? Number(form.area_construida)
            : null,
          status: form.status as "ativo" | "baixado",
        },
      });
      toast.success(form.id ? "Imóvel atualizado" : "Imóvel cadastrado");
      setOpen(false);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };

  const submitBenefit = async (encerrar: boolean) => {
    if (!activeTenant || !benefitTarget) return;
    setBusy(true);
    try {
      await setBenefit({
        data: {
          tenant_id: activeTenant.id,
          property_id: benefitTarget.id,
          beneficio: encerrar ? null : (beneficio as "imunidade" | "isencao"),
          motivo: motivo.trim(),
        },
      });
      toast.success(
        encerrar
          ? "Benefício encerrado: o imóvel volta a lançar IPTU"
          : "Benefício de IPTU concedido",
      );
      setBenefitTarget(null);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao gravar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Home className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              Cadastro imobiliário
            </h1>
            <p className="text-sm text-muted-foreground">
              Base do IPTU: imóveis, valor venal, áreas e imunidade/isenção
            </p>
          </div>
        </div>
        {canManage && (
          <Button variant="outline" onClick={openNew}>
            <Plus className="size-4" /> Novo imóvel
          </Button>
        )}
      </div>

      {summary && (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Imóveis ativos</div>
            <div className="text-2xl font-bold">{summary.ativos}</div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Baixados</div>
            <div className="text-2xl font-bold">{summary.baixados}</div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">
              Valor venal tributável
            </div>
            <div className="text-2xl font-bold">
              {brl(summary.valorVenalTributavel)}
            </div>
          </div>
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm text-muted-foreground">Área construída</div>
            <div className="text-2xl font-bold">
              {summary.areaConstruidaTotal.toLocaleString("pt-BR")} m²
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="p-3 font-semibold">Inscrição</th>
              <th className="p-3 font-semibold">Proprietário</th>
              <th className="p-3 font-semibold">Endereço</th>
              <th className="p-3 font-semibold text-right">Valor venal</th>
              <th className="p-3 font-semibold">Situação</th>
              {canManage && <th className="p-3 font-semibold">Ações</th>}
            </tr>
          </thead>
          <tbody>
            {properties.map((p) => (
              <tr key={p.id} className="border-b last:border-0">
                <td className="p-3 font-medium">{p.inscricao_imobiliaria}</td>
                <td className="p-3">
                  {p.proprietario}
                  <div className="text-xs text-muted-foreground">
                    {p.proprietario_documento}
                  </div>
                </td>
                <td className="p-3">{p.endereco}</td>
                <td className="p-3 text-right tabular-nums">
                  {brl(p.valor_venal)}
                </td>
                <td className="p-3 space-x-1">
                  <Badge variant={p.status === "ativo" ? "default" : "outline"}>
                    {p.status}
                  </Badge>
                  {p.beneficio_iptu && (
                    <Badge
                      variant="secondary"
                      title={p.beneficio_iptu_motivo ?? ""}
                    >
                      {p.beneficio_iptu} de IPTU
                    </Badge>
                  )}
                </td>
                {canManage && (
                  <td className="p-3">
                    <div className="flex gap-2 flex-wrap">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEdit(p)}
                      >
                        <Pencil className="size-4" /> Editar
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setBenefitTarget(p);
                          setBeneficio(p.beneficio_iptu ?? "imunidade");
                          setMotivo(p.beneficio_iptu_motivo ?? "");
                        }}
                      >
                        <ShieldCheck className="size-4" /> Imunidade/isenção
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {properties.length === 0 && (
              <tr>
                <td
                  colSpan={canManage ? 6 : 5}
                  className="p-6 text-center text-muted-foreground"
                >
                  Nenhum imóvel cadastrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Cadastro / edição */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {form.id ? "Editar imóvel" : "Novo imóvel"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Inscrição imobiliária</Label>
                <Input
                  value={form.inscricao_imobiliaria}
                  onChange={(e) => set("inscricao_imobiliaria", e.target.value)}
                />
              </div>
              <div>
                <Label>Situação</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => set("status", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ativo">Ativo</SelectItem>
                    <SelectItem value="baixado">Baixado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Proprietário</Label>
                <Input
                  value={form.proprietario}
                  onChange={(e) => set("proprietario", e.target.value)}
                />
              </div>
              <div>
                <Label>Documento (CPF/CNPJ)</Label>
                <Input
                  value={form.proprietario_documento}
                  onChange={(e) =>
                    set("proprietario_documento", e.target.value)
                  }
                />
              </div>
            </div>
            <div>
              <Label>Endereço</Label>
              <Input
                value={form.endereco}
                onChange={(e) => set("endereco", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>Valor venal</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.valor_venal}
                  onChange={(e) => set("valor_venal", e.target.value)}
                />
              </div>
              <div>
                <Label>Área do terreno (m²)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.area_terreno}
                  onChange={(e) => set("area_terreno", e.target.value)}
                />
              </div>
              <div>
                <Label>Área construída (m²)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.area_construida}
                  onChange={(e) => set("area_construida", e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submit}
              disabled={
                busy ||
                !form.inscricao_imobiliaria.trim() ||
                !form.proprietario.trim() ||
                !form.endereco.trim() ||
                !(Number(form.valor_venal) > 0)
              }
            >
              {form.id ? "Salvar" : "Cadastrar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Imunidade / isenção (O4-04c, CF art. 150, VI) */}
      <Dialog
        open={Boolean(benefitTarget)}
        onOpenChange={(o) => !o && setBenefitTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Imunidade / isenção — {benefitTarget?.inscricao_imobiliaria}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Imóvel imune (CF art. 150, VI) ou isento (lei municipal) não
              recebe lançamento de IPTU — avulso nem em lote.
            </p>
            <div>
              <Label>Benefício</Label>
              <Select value={beneficio} onValueChange={setBeneficio}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="imunidade">
                    Imunidade (CF art. 150, VI)
                  </SelectItem>
                  <SelectItem value="isencao">
                    Isenção (lei municipal)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Fundamento legal</Label>
              <Input
                value={motivo}
                placeholder="Ex.: CF art. 150, VI, b — templo de qualquer culto"
                onChange={(e) => setMotivo(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            {benefitTarget?.beneficio_iptu && (
              <Button
                variant="outline"
                onClick={() => submitBenefit(true)}
                disabled={busy}
              >
                Encerrar benefício
              </Button>
            )}
            <Button
              onClick={() => submitBenefit(false)}
              disabled={busy || motivo.trim().length < 3}
            >
              Conceder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
