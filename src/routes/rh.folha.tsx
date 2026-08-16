import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Wallet, Calculator, Lock, Settings, RotateCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { calcPayrollMonth, type INSSFaixa, type IRRFFaixa } from "@/lib/payroll";

export const Route = createFileRoute("/rh/folha")({ component: Page });

function Page() {
  const { session, hasPermission, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasPermission("close_payroll")) { toast.error("Sem permissão"); nav({ to: "/app" }); }
  }, [session, hasPermission, loading, nav]);
  if (!session || !hasPermission("close_payroll")) return null;
  return <Content />;
}

type PayrollConfigRow = {
  id: string;
  salario_minimo: number;
  teto_inss: number;
  inss_faixas: INSSFaixa[];
  irrf_faixas: IRRFFaixa[];
  deducao_dependente: number;
};

function Content() {
  const qc = useQueryClient();
  const [refMonth, setRefMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const monthDate = new Date(refMonth + "-01T00:00:00");

  const { data: config } = useQuery({
    queryKey: ["payroll-config"],
    queryFn: async () => {
      const { data } = await supabase.from("payroll_config").select("*").limit(1).maybeSingle();
      return data as PayrollConfigRow | null;
    },
  });

  const { data: rows } = useQuery({
    queryKey: ["folha", refMonth],
    queryFn: async () => {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("*, work_schedules(*)");
      const ids = (profiles ?? []).map((p) => p.id);
      const { data: existing } = await supabase
        .from("payroll_periods").select("*").eq("ref_month", refMonth + "-01").in("user_id", ids);
      return (profiles ?? []).map((p) => ({
        profile: p,
        period: (existing ?? []).find((x) => x.user_id === p.id) ?? null,
      }));
    },
  });

  const calcOne = async (userId: string) => {
    if (!config) return toast.error("Configuração da folha não carregada");
    const row = rows?.find((r) => r.profile.id === userId);
    if (!row) return;
    const profile = row.profile as Record<string, unknown> & {
      id: string; salario: number | null;
      work_schedules: { tipo: "fixed_weekly" | "rotative"; config: unknown; carga_horaria_mensal: number } | null;
    };
    if (!profile.work_schedules) return toast.error("Funcionário sem escala atribuída");
    if (!profile.salario) return toast.error("Funcionário sem salário base");

    const start = new Date(monthDate); start.setHours(0, 0, 0, 0);
    const end = new Date(monthDate); end.setMonth(end.getMonth() + 1); end.setHours(0, 0, 0, 0);
    const { data: entries } = await supabase
      .from("time_entries").select("*").eq("user_id", userId)
      .gte("entry_at", start.toISOString()).lt("entry_at", end.toISOString());

    const calc = calcPayrollMonth({
      ref_month: monthDate,
      schedule: profile.work_schedules,
      entries: entries ?? [],
      salario_base: Number(profile.salario),
      carga_horaria_mensal: profile.work_schedules.carga_horaria_mensal,
      vale_alimentacao_diario: Number(profile.vale_alimentacao_diario ?? 0),
      vale_transporte_diario: Number(profile.vale_transporte_diario ?? 0),
      desconto_vt_funcionario: Boolean(profile.desconto_vt_funcionario ?? true),
      insalubridade_pct: Number(profile.insalubridade_pct ?? 0),
      periculosidade_pct: Number(profile.periculosidade_pct ?? 0),
      adicional_noturno: Boolean(profile.adicional_noturno ?? false),
      plano_saude_desconto: Number(profile.plano_saude_desconto ?? 0),
      outros_descontos: Number(profile.outros_descontos ?? 0),
      outros_proventos: Number(profile.outros_proventos ?? 0),
      dependentes_ir: Number(profile.dependentes_ir ?? 0),
      desconta_inss: Boolean(profile.desconta_inss ?? true),
      desconta_irrf: Boolean(profile.desconta_irrf ?? true),
      salario_minimo: Number(config.salario_minimo),
      teto_inss: Number(config.teto_inss),
      inss_faixas: config.inss_faixas,
      irrf_faixas: config.irrf_faixas,
      deducao_dependente: Number(config.deducao_dependente),
    });

    const { error } = await supabase.from("payroll_periods").upsert({
      user_id: userId, ref_month: refMonth + "-01",
      ...calc, status: "aberto", calculated_at: new Date().toISOString(),
    }, { onConflict: "user_id,ref_month" });
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["folha"] });
  };

  const calcAll = async () => {
    if (!rows) return;
    let ok = 0, fail = 0;
    for (const r of rows) {
      try { await calcOne(r.profile.id); ok++; } catch { fail++; }
    }
    toast.success(`Recalculado: ${ok} | falhas: ${fail}`);
  };

  const close = async (userId: string) => {
    const { error } = await supabase.from("payroll_periods")
      .update({ status: "fechado", closed_at: new Date().toISOString() })
      .eq("user_id", userId).eq("ref_month", refMonth + "-01");
    if (error) return toast.error(error.message);
    toast.success("Fechado");
    qc.invalidateQueries({ queryKey: ["folha"] });
  };

  const fmtBRL = (n: number) => Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Wallet className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Folha de pagamento</h1>
            <p className="text-sm text-muted-foreground">Cálculo automático a partir do ponto e das rubricas do cadastro.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Label className="text-xs">Mês</Label>
          <Input type="month" value={refMonth} onChange={(e) => setRefMonth(e.target.value)} className="w-40" />
          <Button size="sm" variant="outline" onClick={calcAll}>
            <RotateCw className="size-3.5 mr-1" /> Recalcular todos
          </Button>
          {config && <ConfigDialog config={config} onSaved={() => qc.invalidateQueries({ queryKey: ["payroll-config"] })} />}
        </div>
      </div>

      <div className="space-y-2">
        {rows?.map(({ profile, period }) => {
          const p = profile as unknown as { id: string; full_name: string | null; email: string | null };
          return (
            <div key={p.id} className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="font-semibold">{p.full_name || p.email}</div>
                  <div className="text-xs text-muted-foreground font-mono">{p.email}</div>
                </div>
                <div className="flex items-center gap-2">
                  {period && <Badge variant={period.status === "fechado" ? "default" : "secondary"}>
                    {period.status === "fechado" ? "Fechado" : "Aberto"}
                  </Badge>}
                  <Button size="sm" variant="outline" onClick={() => calcOne(p.id)} disabled={period?.status === "fechado"}>
                    <Calculator className="size-3.5" />Calcular
                  </Button>
                  {period && period.status === "aberto" && (
                    <Button size="sm" onClick={() => close(p.id)}><Lock className="size-3.5" />Fechar</Button>
                  )}
                </div>
              </div>
              {period && (
                <div className="pt-2 border-t border-border space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <Stat k="Dias trab." v={`${period.dias_trabalhados ?? 0}`} />
                    <Stat k="Horas trab." v={`${period.horas_trabalhadas}h / ${period.horas_previstas}h`} />
                    <Stat k="Extras 50%" v={`${period.horas_extras_50}h`} />
                    <Stat k="Extras 100%" v={`${period.horas_extras_100}h`} />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <div className="space-y-1">
                      <div className="text-xs uppercase font-bold tracking-wider text-emerald-700 dark:text-emerald-400">Proventos</div>
                      <Line k="Salário base" v={fmtBRL(period.salario_base)} />
                      <Line k="Horas extras" v={fmtBRL(period.valor_extras)} />
                      <Line k="Insalubridade" v={fmtBRL(period.adicional_insalubridade ?? 0)} />
                      <Line k="Periculosidade" v={fmtBRL(period.adicional_periculosidade ?? 0)} />
                      <Line k="Adic. noturno" v={fmtBRL(period.adicional_noturno_valor ?? 0)} />
                      <Line k="Vale alimentação" v={fmtBRL(period.vale_alimentacao_total ?? 0)} />
                      <Line k="Vale transporte" v={fmtBRL(period.vale_transporte_total ?? 0)} />
                      <Line k="Outros proventos" v={fmtBRL(period.outros_proventos ?? 0)} />
                      <Line k="Total" v={fmtBRL(period.total_proventos ?? 0)} bold />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs uppercase font-bold tracking-wider text-rose-700 dark:text-rose-400">Descontos</div>
                      <Line k="Faltas/atrasos" v={fmtBRL(period.desconto_faltas)} />
                      <Line k="VT (6%)" v={fmtBRL(period.desconto_vt ?? 0)} />
                      <Line k="INSS" v={fmtBRL(period.inss ?? 0)} />
                      <Line k="IRRF" v={fmtBRL(period.irrf ?? 0)} />
                      <Line k="Plano de saúde" v={fmtBRL(period.plano_saude ?? 0)} />
                      <Line k="Outros descontos" v={fmtBRL(period.outros_descontos ?? 0)} />
                      <Line k="FGTS (informativo)" v={fmtBRL(period.fgts ?? 0)} muted />
                      <Line k="Total" v={fmtBRL(period.total_descontos ?? 0)} bold />
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <span className="text-sm font-bold uppercase tracking-wider">Líquido a pagar</span>
                    <span className="font-mono font-bold text-lg text-primary">{fmtBRL(period.salario_final)}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!rows?.length && <div className="text-center text-muted-foreground py-12">Nenhum funcionário.</div>}
      </div>
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground tracking-wider">{k}</div>
      <div className="font-mono font-semibold">{v}</div>
    </div>
  );
}

function Line({ k, v, bold, muted }: { k: string; v: string; bold?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${bold ? "border-t border-border pt-1 mt-1 font-bold" : ""} ${muted ? "text-muted-foreground" : ""}`}>
      <span className="text-xs">{k}</span>
      <span className="font-mono text-sm">{v}</span>
    </div>
  );
}

function ConfigDialog({ config, onSaved }: { config: PayrollConfigRow; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [sm, setSm] = useState(String(config.salario_minimo));
  const [teto, setTeto] = useState(String(config.teto_inss));
  const [dep, setDep] = useState(String(config.deducao_dependente));
  const [inssJson, setInssJson] = useState(JSON.stringify(config.inss_faixas, null, 2));
  const [irrfJson, setIrrfJson] = useState(JSON.stringify(config.irrf_faixas, null, 2));

  const save = async () => {
    try {
      const inss = JSON.parse(inssJson);
      const irrf = JSON.parse(irrfJson);
      const { error } = await supabase.from("payroll_config").update({
        salario_minimo: Number(sm),
        teto_inss: Number(teto),
        deducao_dependente: Number(dep),
        inss_faixas: inss,
        irrf_faixas: irrf,
      }).eq("id", config.id);
      if (error) throw error;
      toast.success("Configurações salvas");
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "JSON inválido");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><Settings className="size-3.5 mr-1" />Configurações</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Configurações da folha</DialogTitle></DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Salário mínimo</Label>
            <Input type="number" step="0.01" value={sm} onChange={(e) => setSm(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Teto INSS</Label>
            <Input type="number" step="0.01" value={teto} onChange={(e) => setTeto(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Dedução por dependente</Label>
            <Input type="number" step="0.01" value={dep} onChange={(e) => setDep(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Faixas INSS (JSON)</Label>
          <Textarea rows={6} value={inssJson} onChange={(e) => setInssJson(e.target.value)} className="font-mono text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Faixas IRRF (JSON)</Label>
          <Textarea rows={6} value={irrfJson} onChange={(e) => setIrrfJson(e.target.value)} className="font-mono text-xs" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={save}>Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
