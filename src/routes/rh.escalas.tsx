import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Calendar, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/rh/escalas")({ component: Page });

const DAYS = [
  { key: "mon", label: "Seg" }, { key: "tue", label: "Ter" }, { key: "wed", label: "Qua" },
  { key: "thu", label: "Qui" }, { key: "fri", label: "Sex" }, { key: "sat", label: "Sáb" }, { key: "sun", label: "Dom" },
];

function Page() {
  const { session, hasPermission, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!hasPermission("configure_schedules")) { toast.error("Sem permissão"); nav({ to: "/app" }); }
  }, [session, hasPermission, loading, nav]);
  if (!session || !hasPermission("configure_schedules")) return null;
  return <Content />;
}

function Content() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: schedules } = useQuery({
    queryKey: ["schedules"],
    queryFn: async () => (await supabase.from("work_schedules").select("*").order("nome")).data ?? [],
  });

  const remove = async (id: string) => {
    if (!confirm("Excluir escala?")) return;
    const { error } = await supabase.from("work_schedules").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Escala excluída");
    qc.invalidateQueries({ queryKey: ["schedules"] });
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Calendar className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Escalas de trabalho</h1>
            <p className="text-sm text-muted-foreground">Defina jornadas e atribua a funcionários.</p>
          </div>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="size-4" />Nova escala</Button></DialogTrigger>
          <ScheduleDialog onSaved={() => { setOpen(false); qc.invalidateQueries({ queryKey: ["schedules"] }); }} />
        </Dialog>
      </div>

      <div className="grid gap-3">
        {schedules?.map((s) => (
          <div key={s.id} className="rounded-lg border border-border p-4 flex items-start justify-between gap-3">
            <div className="space-y-1.5">
              <div className="font-semibold flex items-center gap-2">
                {s.nome}
                <Badge variant={s.tipo === "fixed_weekly" ? "secondary" : "outline"}>
                  {s.tipo === "fixed_weekly" ? "Fixa semanal" : "Rotativa"}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                Carga mensal: {s.carga_horaria_mensal}h ·{" "}
                {s.tipo === "fixed_weekly"
                  ? Object.entries((s.config as Record<string, { start: string; end: string } | undefined>) ?? {})
                      .filter(([, v]) => v).map(([k, v]) => `${k}: ${v!.start}-${v!.end}`).join(" · ")
                  : `${(s.config as Record<string, string>).pattern} · ${(s.config as Record<string, string>).shift_start}-${(s.config as Record<string, string>).shift_end}`}
              </div>
            </div>
            <Button size="icon" variant="ghost" onClick={() => remove(s.id)}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        {!schedules?.length && <div className="text-center text-muted-foreground py-12">Nenhuma escala criada.</div>}
      </div>
    </section>
  );
}

function ScheduleDialog({ onSaved }: { onSaved: () => void }) {
  const [nome, setNome] = useState("");
  const [tipo, setTipo] = useState<"fixed_weekly" | "rotative">("fixed_weekly");
  const [carga, setCarga] = useState("220");
  const [weekly, setWeekly] = useState<Record<string, { start: string; end: string; break_min: number; on: boolean }>>(
    Object.fromEntries(DAYS.map((d) => [d.key, { start: "08:00", end: "17:00", break_min: 60, on: ["mon","tue","wed","thu","fri"].includes(d.key) }])),
  );
  const [pattern, setPattern] = useState<"12x36" | "6x1" | "5x2">("12x36");
  const [shiftStart, setShiftStart] = useState("07:00");
  const [shiftEnd, setShiftEnd] = useState("19:00");
  const [refDate, setRefDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!nome.trim()) return toast.error("Nome obrigatório");
    setSaving(true);
    let config: Record<string, unknown> = {};
    if (tipo === "fixed_weekly") {
      config = Object.fromEntries(
        Object.entries(weekly).filter(([, v]) => v.on).map(([k, v]) => [k, { start: v.start, end: v.end, break_min: v.break_min }]),
      );
    } else {
      config = { pattern, shift_start: shiftStart, shift_end: shiftEnd, reference_date: refDate };
    }
    const { error } = await supabase.from("work_schedules").insert({
      nome, tipo, config: config as never, carga_horaria_mensal: Number(carga) || 220,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Escala criada");
    onSaved();
  };

  return (
    <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Nova escala</DialogTitle></DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Nome</Label>
          <Input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex: Comercial 8h-17h" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Tipo</Label>
            <Select value={tipo} onValueChange={(v) => setTipo(v as "fixed_weekly" | "rotative")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed_weekly">Fixa semanal</SelectItem>
                <SelectItem value="rotative">Rotativa</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Carga mensal (h)</Label>
            <Input type="number" value={carga} onChange={(e) => setCarga(e.target.value)} />
          </div>
        </div>

        {tipo === "fixed_weekly" ? (
          <div className="space-y-2">
            <Label>Jornada por dia</Label>
            {DAYS.map((d) => (
              <div key={d.key} className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 w-16 text-sm">
                  <input type="checkbox" checked={weekly[d.key].on}
                    onChange={(e) => setWeekly({ ...weekly, [d.key]: { ...weekly[d.key], on: e.target.checked } })} />
                  {d.label}
                </label>
                <Input type="time" value={weekly[d.key].start} disabled={!weekly[d.key].on}
                  onChange={(e) => setWeekly({ ...weekly, [d.key]: { ...weekly[d.key], start: e.target.value } })} className="flex-1" />
                <Input type="time" value={weekly[d.key].end} disabled={!weekly[d.key].on}
                  onChange={(e) => setWeekly({ ...weekly, [d.key]: { ...weekly[d.key], end: e.target.value } })} className="flex-1" />
                <Input type="number" value={weekly[d.key].break_min} disabled={!weekly[d.key].on} placeholder="int. min"
                  onChange={(e) => setWeekly({ ...weekly, [d.key]: { ...weekly[d.key], break_min: Number(e.target.value) } })} className="w-20" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Padrão</Label>
              <Select value={pattern} onValueChange={(v) => setPattern(v as "12x36" | "6x1" | "5x2")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="12x36">12x36</SelectItem>
                  <SelectItem value="6x1">6x1</SelectItem>
                  <SelectItem value="5x2">5x2</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Início</Label><Input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Fim</Label><Input type="time" value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} /></div>
            </div>
            <div className="space-y-1.5">
              <Label>Data de referência (1º dia trabalhado)</Label>
              <Input type="date" value={refDate} onChange={(e) => setRefDate(e.target.value)} />
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={saving}>{saving ? "Salvando..." : "Criar escala"}</Button>
      </DialogFooter>
    </DialogContent>
  );
}
