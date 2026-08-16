import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Check, X, Filter } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/rh")({
  component: RhPage,
});

type Status = "pendente" | "aprovado" | "rejeitado";

function RhPage() {
  const { session, isRh, loading } = useAuth();
  const nav = useNavigate();
  const { location } = useRouterState();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!isRh) {
      toast.error("Acesso restrito ao RH");
      nav({ to: "/app" });
    }
  }, [session, isRh, loading, nav]);

  if (!session || !isRh) return null;
  const isRhHome = location.pathname === "/rh";
  return (
    <AppShell>
      {isRhHome ? <RhContent /> : <Outlet />}
    </AppShell>
  );
}

function RhContent() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Status | "todos">("pendente");
  const [reviewing, setReviewing] = useState<{ id: string; nome: string; action: "aprovado" | "rejeitado" } | null>(null);
  const [obs, setObs] = useState("");

  const { data: list } = useQuery({
    queryKey: ["rh-atestados", filter],
    queryFn: async () => {
      let q = supabase.from("atestados").select("*").order("created_at", { ascending: false });
      if (filter !== "todos") q = q.eq("status", filter);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });

  const { data: stats } = useQuery({
    queryKey: ["rh-stats"],
    queryFn: async () => {
      const { data, error } = await supabase.from("atestados").select("status");
      if (error) throw error;
      return {
        pendente: data.filter((d) => d.status === "pendente").length,
        aprovado: data.filter((d) => d.status === "aprovado").length,
        rejeitado: data.filter((d) => d.status === "rejeitado").length,
        total: data.length,
      };
    },
  });

  const review = async () => {
    if (!reviewing || !user) return;
    const { error } = await supabase
      .from("atestados")
      .update({
        status: reviewing.action,
        rh_observacao: obs || null,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", reviewing.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    await supabase.from("audit_logs").insert({
      actor_id: user.id,
      atestado_id: reviewing.id,
      action: reviewing.action,
      metadata: { observacao: obs },
    });
    toast.success(`Atestado ${reviewing.action}`);
    setReviewing(null);
    setObs("");
    qc.invalidateQueries({ queryKey: ["rh-atestados"] });
    qc.invalidateQueries({ queryKey: ["rh-stats"] });
  };

  const download = async (path: string) => {
    const { data, error } = await supabase.storage.from("atestados").createSignedUrl(path, 60);
    if (error || !data) {
      toast.error("Não foi possível gerar o link");
      return;
    }
    window.open(data.signedUrl, "_blank");
  };

  return (
    <div className="space-y-8 animate-in-up">
      <div>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight leading-[1.1]">Painel RH</h1>
        <p className="text-muted-foreground mt-2 text-sm">Aprovação e auditoria de atestados médicos.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <Stat label="Pendentes" value={stats?.pendente} accent="text-warning" />
        <Stat label="Aprovados" value={stats?.aprovado} accent="text-success" />
        <Stat label="Rejeitados" value={stats?.rejeitado} accent="text-destructive" />
        <Stat label="Total" value={stats?.total} accent="text-foreground" />
      </div>

      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
        <div className="px-5 md:px-6 py-4 border-b border-border bg-muted/30 flex items-center justify-between gap-2">
          <h2 className="font-bold text-xs uppercase tracking-widest">Fila de aprovação</h2>
          <div className="flex items-center gap-1.5 text-xs">
            <Filter className="size-3.5 text-muted-foreground" />
            {(["pendente", "aprovado", "rejeitado", "todos"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`px-2.5 py-1 rounded-md font-semibold capitalize transition-colors ${
                  filter === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="divide-y divide-border">
          {(list ?? []).length === 0 && (
            <p className="p-8 text-sm text-muted-foreground text-center">Nada aqui.</p>
          )}
          {list?.map((a) => (
            <div key={a.id} className="px-5 md:px-6 py-4 flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="size-10 bg-muted rounded-lg flex items-center justify-center font-bold text-muted-foreground text-xs shrink-0">
                  {(a.paciente_nome || "?").split(" ").map((p) => p[0]).slice(0, 2).join("")}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{a.paciente_nome || "(Sem nome)"}</p>
                  <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
                    {a.cid && `CID ${a.cid} · `}{a.dias_afastamento ?? "—"}d · {a.data_inicio || "?"} → {a.data_fim || "?"} · Dr(a) {a.medico_nome || "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusBadge status={a.status} />
                <Button size="sm" variant="outline" onClick={() => download(a.arquivo_path)} title="Baixar arquivo">
                  <Download className="size-3.5" />
                </Button>
                {a.status === "pendente" && (
                  <>
                    <Button size="sm" className="bg-success text-success-foreground hover:bg-success/90" onClick={() => { setReviewing({ id: a.id, nome: a.paciente_nome ?? "", action: "aprovado" }); setObs(""); }}>
                      <Check className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => { setReviewing({ id: a.id, nome: a.paciente_nome ?? "", action: "rejeitado" }); setObs(""); }}>
                      <X className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Dialog open={!!reviewing} onOpenChange={(o) => !o && setReviewing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewing?.action === "aprovado" ? "Aprovar atestado" : "Rejeitar atestado"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{reviewing?.nome}</p>
          <Textarea
            placeholder="Observação (opcional)"
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            rows={3}
            maxLength={500}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(null)}>Cancelar</Button>
            <Button
              className={reviewing?.action === "aprovado" ? "bg-success text-success-foreground hover:bg-success/90" : ""}
              variant={reviewing?.action === "rejeitado" ? "destructive" : "default"}
              onClick={review}
            >
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value?: number; accent: string }) {
  return (
    <div className="bg-card border border-border p-4 md:p-5 rounded-2xl">
      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-2xl md:text-3xl font-extrabold mt-1 ${accent}`}>{value ?? "—"}</p>
    </div>
  );
}
