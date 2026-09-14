import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Ticket,
  Download,
  Building2,
  Plus,
  Pencil,
  RotateCw,
  AlertTriangle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { workedMinutesForDay, type TimeEntry } from "@/lib/payroll";
import {
  buildVtVaCsv,
  downloadVtVaCsv,
  fmtNum,
  fmtDateBR,
  type VtVaRow,
} from "@/lib/vtva-export";
import {
  downloadVaVrXlsx,
  NUMERO_CONTRATO,
  type VaVrRow,
  type BeneficioAlimentacao,
} from "@/lib/va-vr-export";

export const Route = createFileRoute("/rh/vt-va")({ component: Page });

function Page() {
  const { session, hasPermission, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasPermission("manage_employees")) {
      toast.error("Sem permissão");
      nav({ to: "/app" });
    }
  }, [session, hasPermission, loading, nav]);
  if (!session || !hasPermission("manage_employees")) return null;
  return <Content />;
}

type Unidade = {
  id: string;
  nome: string;
  cnpj: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  ponto_referencia: string | null;
  uf: string | null;
  estado: string | null;
};

type Profile = Record<string, unknown> & {
  id: string;
  full_name: string | null;
  matricula: string | null;
  cpf: string | null;
  status: string | null;
  operacao: string | null;
  vale_transporte_diario: number | null;
  vale_alimentacao_diario: number | null;
  /** Opção do colaborador: VA (alimentação) ou VR (refeição). */
  beneficio_alimentacao: string | null;
  unidade_id: string | null;
  unidades: Unidade | null;
};

/** Conta dias com trabalho efetivo (batidas pareadas > 0 min) no conjunto de entradas. */
function contaDiasTrabalhados(entries: TimeEntry[]): number {
  const byDay = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const d = new Date(e.entry_at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(e);
  }
  let dias = 0;
  for (const es of byDay.values()) if (workedMinutesForDay(es) > 0) dias++;
  return dias;
}

function fmtQty(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return "";
  return String(n).replace(".", ",");
}

function rowFor(p: Profile, dias: number, tipo: "VT" | "VA"): VtVaRow {
  const u = p.unidades;
  const isVT = tipo === "VT";
  return {
    cnpj: u?.cnpj ?? "",
    cep_empresa: u?.cep ?? "",
    logradouro_empresa: u?.logradouro ?? "",
    numero_empresa: u?.numero ?? "",
    complemento_empresa: u?.complemento ?? "",
    ponto_referencia: u?.ponto_referencia ?? "",
    uf_empresa: u?.uf ?? "",
    estado_empresa: u?.estado ?? "",
    matricula: p.matricula ?? "",
    nome: p.full_name ?? "",
    cpf: p.cpf ?? "",
    rg: (p.rg as string) ?? "",
    data_nascimento: fmtDateBR(p.data_nascimento as string),
    cargo: (p.cargo as string) ?? "",
    departamento: p.operacao ?? "",
    nome_mae: (p.nome_mae as string) ?? "",
    beneficio:
      ((isVT ? p.vt_beneficio_codigo : p.va_beneficio_codigo) as string) ?? "",
    valor_unitario: fmtNum(
      isVT ? p.vale_transporte_diario : p.vale_alimentacao_diario,
    ),
    quantidade_diaria: fmtQty(
      (isVT ? p.vt_quantidade_diaria : p.va_quantidade_diaria) as number,
    ),
    dias_trabalhados: String(dias),
    tipo_valor: ((isVT ? p.vt_tipo_valor : p.va_tipo_valor) as string) ?? "",
    rede_recarga:
      ((isVT ? p.vt_rede_recarga : p.va_rede_recarga) as string) ?? "",
    cep_residencial: (p.cep as string) ?? "",
    logradouro_residencial: (p.logradouro as string) ?? "",
    numero_residencial: (p.numero_endereco as string) ?? "",
    complemento_residencial: (p.complemento as string) ?? "",
    estado_civil: (p.estado_civil as string) ?? "",
    data_emissao_rg: fmtDateBR(p.rg_data_emissao as string),
    orgao_expedidor: (p.rg_orgao_emissor as string) ?? "",
    estado_emissao_rg: (p.rg_uf as string) ?? "",
    chave_pix: (p.chave_pix as string) ?? "",
    tipo_chave_pix: (p.tipo_chave_pix as string) ?? "",
    banco: (p.banco as string) ?? "",
  };
}

// VT sai no CSV da operadora de transporte; VA/VR, no XLSX da operadora de alimentação.
type TipoBeneficio = "VT" | "VA" | "VR";
const BENEFICIO_LABEL: Record<TipoBeneficio, string> = {
  VT: "Somente VT",
  VA: "Somente VA",
  VR: "Somente VR",
};

/** VA e VR usam o mesmo valor diário; muda apenas o contrato da operadora. */
const TODOS_DEPTOS = "__todos__";

function Content() {
  const qc = useQueryClient();
  const [refMonth, setRefMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [tipoBeneficio, setTipoBeneficio] = useState<TipoBeneficio>("VT");
  const [departamento, setDepartamento] = useState<string>(TODOS_DEPTOS);
  const monthDate = useMemo(
    () => new Date(refMonth + "-01T00:00:00"),
    [refMonth],
  );

  const { data, isFetching, refetch } = useQuery({
    queryKey: ["vtva", refMonth],
    queryFn: async () => {
      const { data: profiles, error } = await supabase
        .from("profiles")
        .select("*, unidades(*)");
      if (error) throw new Error(error.message);
      // exclui usuário(s) master (papel admin) da apuração de benefícios
      const { data: roles } = await supabase
        .from("user_roles")
        .select("user_id, role");
      const adminIds = new Set(
        (roles ?? [])
          .filter((r) => r.role === "admin")
          .map((r) => r.user_id as string),
      );
      const ativos = ((profiles ?? []) as Profile[]).filter(
        (p) => (p.status ?? "ativo") === "ativo" && !adminIds.has(p.id),
      );

      const start = new Date(monthDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(monthDate);
      end.setMonth(end.getMonth() + 1);
      end.setHours(0, 0, 0, 0);
      const { data: entries } = await supabase
        .from("time_entries")
        .select("user_id, entry_at, tipo")
        .gte("entry_at", start.toISOString())
        .lt("entry_at", end.toISOString());

      const byUser = new Map<string, TimeEntry[]>();
      for (const e of (entries ?? []) as (TimeEntry & { user_id: string })[]) {
        if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
        byUser.get(e.user_id)!.push(e);
      }

      const totalFor = (p: Profile, dias: number, tipo: "VT" | "VA") => {
        const unit =
          Number(
            (tipo === "VT"
              ? p.vale_transporte_diario
              : p.vale_alimentacao_diario) ?? 0,
          ) || 0;
        const qtd =
          Number(
            (tipo === "VT"
              ? p.vt_quantidade_diaria
              : p.va_quantidade_diaria) as number,
          ) || 1;
        return +(unit * qtd * dias).toFixed(2);
      };
      const rows: (VtVaRow & {
        _dias: number;
        _tipo: "VT" | "VA" | "VR";
        _total: number;
        _nascimento: string | null;
      })[] = [];
      let semUnidade = 0,
        semBeneficio = 0,
        semPonto = 0;
      for (const p of ativos) {
        const dias = contaDiasTrabalhados(byUser.get(p.id) ?? []);
        const temVT = Number(p.vale_transporte_diario ?? 0) > 0;
        const temAlim = Number(p.vale_alimentacao_diario ?? 0) > 0;
        // O colaborador opta por VA ou VR; o valor diário é o mesmo campo.
        const tipoAlim: BeneficioAlimentacao =
          p.beneficio_alimentacao === "VR" ? "VR" : "VA";
        const nascimento = (p.data_nascimento as string) ?? null;
        if (!p.unidade_id) semUnidade++;
        if (!temVT && !temAlim) {
          semBeneficio++;
          continue;
        }
        if (dias === 0) semPonto++;
        if (temVT) {
          rows.push({
            ...rowFor(p, dias, "VT"),
            _dias: dias,
            _tipo: "VT",
            _total: totalFor(p, dias, "VT"),
            _nascimento: nascimento,
          });
        }
        if (temAlim) {
          rows.push({
            ...rowFor(p, dias, "VA"),
            _dias: dias,
            _tipo: tipoAlim,
            _total: totalFor(p, dias, "VA"),
            _nascimento: nascimento,
          });
        }
      }
      return {
        rows,
        totalFuncionarios: ativos.length,
        semUnidade,
        semBeneficio,
        semPonto,
      };
    },
  });

  // Departamentos disponíveis (a partir dos funcionários apurados).
  const departamentos = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.rows ?? [])
      if (r.departamento) set.add(r.departamento);
    return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [data?.rows]);

  const rows = (data?.rows ?? []).filter(
    (r) =>
      r._tipo === tipoBeneficio &&
      (departamento === TODOS_DEPTOS || r.departamento === departamento),
  );

  const totalPagar = rows.reduce((s, r) => s + (r._total || 0), 0);
  const fmtBRL = (n: number) =>
    n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const slug = (s: string) =>
    s
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();

  const exportar = async () => {
    if (!rows.length) {
      toast.error("Nada para exportar. Configure benefícios nos funcionários.");
      return;
    }
    const sufixoDepto =
      departamento === TODOS_DEPTOS ? "" : `-${slug(departamento)}`;

    // VA e VR saem no layout da operadora de alimentação (XLSX, 8 colunas).
    if (tipoBeneficio === "VA" || tipoBeneficio === "VR") {
      const contrato = NUMERO_CONTRATO[tipoBeneficio];
      const planilha: VaVrRow[] = rows.map((r) => ({
        matricula: r.matricula,
        cpf: r.cpf,
        nome: r.nome,
        data_nascimento: r._nascimento,
        departamento: r.departamento,
        unidade_entrega: r.departamento,
        valor_mensal: r._total,
        numero_contrato: contrato,
      }));
      await downloadVaVrXlsx(
        `${tipoBeneficio.toLowerCase()}-${refMonth}${sufixoDepto}.xlsx`,
        planilha,
      );
      toast.success(
        `Exportadas ${planilha.length} linhas (${BENEFICIO_LABEL[tipoBeneficio]})`,
      );
      return;
    }

    // VT segue no CSV de 33 colunas da operadora de transporte.
    const clean: VtVaRow[] = rows.map(
      ({ _dias, _tipo, _total, _nascimento, ...r }) => r,
    );
    downloadVtVaCsv(`vt-${refMonth}${sufixoDepto}.csv`, buildVtVaCsv(clean));
    toast.success(
      `Exportadas ${clean.length} linhas (${BENEFICIO_LABEL[tipoBeneficio]})`,
    );
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Ticket className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              VT e VA / VR
            </h1>
            <p className="text-sm text-muted-foreground">
              Exportação da planilha de benefícios a partir do cadastro e do
              ponto do mês.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Label className="text-xs shrink-0">Mês</Label>
            <Input
              type="month"
              value={refMonth}
              onChange={(e) => setRefMonth(e.target.value)}
              className="w-[190px]"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="text-xs shrink-0">Benefício</Label>
            <Select
              value={tipoBeneficio}
              onValueChange={(v) => setTipoBeneficio(v as TipoBeneficio)}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="VT">Somente VT</SelectItem>
                <SelectItem value="VA">Somente VA</SelectItem>
                <SelectItem value="VR">Somente VR</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="text-xs shrink-0">Departamento</Label>
            <Select value={departamento} onValueChange={setDepartamento}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS_DEPTOS}>Todos</SelectItem>
                {departamentos.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RotateCw className="size-3.5 mr-1" /> Recalcular
          </Button>
          <UnidadesDialog
            onChanged={() => {
              qc.invalidateQueries({ queryKey: ["unidades-options"] });
              refetch();
            }}
          />
          <Button size="sm" onClick={exportar} disabled={!rows.length}>
            <Download className="size-3.5 mr-1" />
            Exportar{" "}
            {tipoBeneficio === "VA" || tipoBeneficio === "VR" ? "XLSX" : "CSV"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          label={`Total ${BENEFICIO_LABEL[tipoBeneficio]} a pagar`}
          value={fmtBRL(totalPagar)}
          highlight
        />
        <StatCard label="Linhas a exportar" value={String(rows.length)} />
        <StatCard
          label="Funcionários ativos"
          value={String(data?.totalFuncionarios ?? 0)}
        />
        <StatCard
          label="Sem benefício"
          value={String(data?.semBeneficio ?? 0)}
          warn={!!data?.semBeneficio}
        />
        <StatCard
          label="Sem ponto no mês"
          value={String(data?.semPonto ?? 0)}
          warn={!!data?.semPonto}
        />
      </div>

      {!!data?.semUnidade && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
          <AlertTriangle className="size-4 text-amber-600 mt-0.5 shrink-0" />
          <span>
            {data.semUnidade} funcionário(s) ativo(s) sem unidade vinculada — as
            colunas de empresa (CNPJ/endereço) sairão em branco para eles.
          </span>
        </div>
      )}

      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
        <div className="px-5 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
          <h2 className="font-bold text-xs uppercase tracking-widest">
            Prévia{" "}
            {isFetching && (
              <span className="text-muted-foreground">· carregando…</span>
            )}
          </h2>
          <span className="text-xs text-muted-foreground">
            exibindo até 200 de {rows.length}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase text-muted-foreground border-b border-border">
                <th className="px-3 py-2">Matrícula</th>
                <th className="px-3 py-2">Nome</th>
                <th className="px-3 py-2">Departamento</th>
                <th className="px-3 py-2">Benefício</th>
                <th className="px-3 py-2">Código</th>
                <th className="px-3 py-2 text-right">Valor unit.</th>
                <th className="px-3 py-2 text-right">Qtd/dia</th>
                <th className="px-3 py-2 text-right">Dias trab.</th>
                <th className="px-3 py-2 text-right">Total a pagar</th>
                <th className="px-3 py-2">Unidade</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="px-3 py-2 font-mono">{r.matricula || "—"}</td>
                  <td className="px-3 py-2">{r.nome || "—"}</td>
                  <td className="px-3 py-2">{r.departamento || "—"}</td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary">{r._tipo}</Badge>
                  </td>
                  <td className="px-3 py-2 font-mono">{r.beneficio || "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.valor_unitario || "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.quantidade_diaria || "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.dias_trabalhados}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">
                    {fmtBRL(r._total)}
                  </td>
                  <td className="px-3 py-2 truncate max-w-[160px]">
                    {r.cnpj ? `${r.uf_empresa} · ${r.cnpj}` : "—"}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td
                    colSpan={10}
                    className="px-3 py-10 text-center text-muted-foreground"
                  >
                    Nenhuma linha. Cadastre unidades, atribua valores de VT/VA
                    aos funcionários e registre o ponto do mês.
                  </td>
                </tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-border font-bold">
                  <td className="px-3 py-2" colSpan={7}>
                    Total ({BENEFICIO_LABEL[tipoBeneficio]}) — {rows.length}{" "}
                    linha(s)
                  </td>
                  <td
                    className="px-3 py-2 text-right font-mono text-primary"
                    colSpan={2}
                  >
                    {fmtBRL(totalPagar)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </section>
  );
}

function StatCard({
  label,
  value,
  warn,
  highlight,
}: {
  label: string;
  value: string;
  warn?: boolean;
  highlight?: boolean;
}) {
  const cls = highlight
    ? "border-primary/40 bg-primary/5"
    : warn
      ? "border-amber-300 bg-amber-50 dark:bg-amber-950/30"
      : "border-border bg-card";
  return (
    <div className={`rounded-xl border p-4 ${cls}`}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`font-extrabold mt-1 ${highlight ? "text-xl text-primary" : "text-2xl"}`}
      >
        {value}
      </div>
    </div>
  );
}

const EMPTY_UNIDADE: Omit<Unidade, "id"> = {
  nome: "",
  cnpj: "",
  cep: "",
  logradouro: "",
  numero: "",
  complemento: "",
  ponto_referencia: "",
  uf: "",
  estado: "",
};

function UnidadesDialog({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Unidade> | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: unidades, refetch } = useQuery({
    queryKey: ["unidades-list"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("unidades")
        .select("*")
        .order("nome");
      if (error) throw new Error(error.message);
      return (data ?? []) as Unidade[];
    },
  });

  const salvar = async () => {
    if (!editing || !editing.nome?.trim()) {
      toast.error("Informe o nome da unidade");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        nome: editing.nome.trim(),
        cnpj: editing.cnpj || null,
        cep: editing.cep || null,
        logradouro: editing.logradouro || null,
        numero: editing.numero || null,
        complemento: editing.complemento || null,
        ponto_referencia: editing.ponto_referencia || null,
        uf: editing.uf || null,
        estado: editing.estado || null,
      };
      const { error } = editing.id
        ? await supabase.from("unidades").update(payload).eq("id", editing.id)
        : await supabase.from("unidades").insert(payload);
      if (error) throw new Error(error.message);
      toast.success("Unidade salva");
      setEditing(null);
      refetch();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setEditing(null);
      }}
    >
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Building2 className="size-3.5 mr-1" /> Unidades
      </Button>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Unidades (dados da empresa)</DialogTitle>
        </DialogHeader>

        {!editing ? (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => setEditing({ ...EMPTY_UNIDADE })}
              >
                <Plus className="size-3.5 mr-1" /> Nova unidade
              </Button>
            </div>
            <div className="divide-y divide-border rounded-lg border border-border max-h-80 overflow-y-auto">
              {(unidades ?? []).map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{u.nome}</div>
                    <div className="text-xs font-mono text-muted-foreground truncate">
                      {u.cnpj || "sem CNPJ"}
                      {u.uf ? ` · ${u.uf}` : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(u)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </div>
              ))}
              {!unidades?.length && (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Nenhuma unidade cadastrada.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <UField
              label="Nome da unidade *"
              value={editing.nome ?? ""}
              onChange={(v) => setEditing({ ...editing, nome: v })}
            />
            <UField
              label="CNPJ"
              value={editing.cnpj ?? ""}
              onChange={(v) => setEditing({ ...editing, cnpj: v })}
            />
            <UField
              label="CEP"
              value={editing.cep ?? ""}
              onChange={(v) => setEditing({ ...editing, cep: v })}
            />
            <UField
              label="Logradouro"
              value={editing.logradouro ?? ""}
              onChange={(v) => setEditing({ ...editing, logradouro: v })}
            />
            <UField
              label="Número"
              value={editing.numero ?? ""}
              onChange={(v) => setEditing({ ...editing, numero: v })}
            />
            <UField
              label="Complemento"
              value={editing.complemento ?? ""}
              onChange={(v) => setEditing({ ...editing, complemento: v })}
            />
            <UField
              label="Ponto de referência"
              value={editing.ponto_referencia ?? ""}
              onChange={(v) => setEditing({ ...editing, ponto_referencia: v })}
            />
            <UField
              label="UF"
              value={editing.uf ?? ""}
              onChange={(v) => setEditing({ ...editing, uf: v })}
            />
            <UField
              label="Estado"
              value={editing.estado ?? ""}
              onChange={(v) => setEditing({ ...editing, estado: v })}
            />
          </div>
        )}

        <DialogFooter>
          {editing ? (
            <>
              <Button
                variant="outline"
                onClick={() => setEditing(null)}
                disabled={busy}
              >
                Voltar
              </Button>
              <Button onClick={salvar} disabled={busy}>
                {busy ? "Salvando…" : "Salvar unidade"}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setOpen(false)}>
              Fechar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-bold uppercase text-muted-foreground">
        {label}
      </Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
