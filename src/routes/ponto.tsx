import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Clock,
  LogIn,
  Coffee,
  LogOut as LogOutIcon,
  ArrowRight,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { workedMinutesForDay } from "@/lib/payroll";

export const Route = createFileRoute("/ponto")({ component: Page });

function Page() {
  const { session, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (!loading && !session) nav({ to: "/login" });
  }, [loading, session, nav]);
  if (!session) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

const SEQ_4 = ["entrada", "saida_almoco", "volta_almoco", "saida"] as const;
const SEQ_2 = ["entrada", "saida"] as const;
const LABEL: Record<string, { label: string; icon: typeof LogIn }> = {
  entrada: { label: "Entrada", icon: LogIn },
  saida_almoco: { label: "Saída p/ intervalo", icon: Coffee },
  volta_almoco: { label: "Volta do intervalo", icon: ArrowRight },
  saida: { label: "Saída", icon: LogOutIcon },
};

function Content() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: profile } = useQuery({
    queryKey: ["my-profile-ponto", user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("tipo_ponto")
        .eq("id", user!.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user,
  });

  const startOfDay = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);
  const endOfDay = useMemo(() => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }, []);

  const { data: todayEntries } = useQuery({
    queryKey: ["ponto-today", user?.id, startOfDay],
    queryFn: async () => {
      const { data } = await supabase
        .from("time_entries")
        .select("*")
        .eq("user_id", user!.id)
        .gte("entry_at", startOfDay)
        .lte("entry_at", endOfDay)
        .order("entry_at");
      return data ?? [];
    },
    enabled: !!user,
  });

  const sequence = profile?.tipo_ponto === "2_batidas" ? SEQ_2 : SEQ_4;
  const nextTipo = sequence[todayEntries?.length ?? 0];
  const workedMin = workedMinutesForDay(todayEntries ?? []);

  const bater = async () => {
    if (!nextTipo) {
      toast.info("Já bateu todos os pontos do dia.");
      return;
    }
    const { error } = await supabase.from("time_entries").insert({
      user_id: user!.id,
      tipo: nextTipo,
      origem: "app",
    });
    if (error) return toast.error(error.message);
    toast.success(`${LABEL[nextTipo].label} registrada!`);
    qc.invalidateQueries({ queryKey: ["ponto-today"] });
  };

  return (
    <section className="space-y-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3">
        <Clock className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            Ponto eletrônico
          </h1>
          <p className="text-sm text-muted-foreground">
            {new Date().toLocaleDateString("pt-BR", {
              weekday: "long",
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border p-6 text-center space-y-4">
        <div className="text-5xl font-mono font-bold tabular-nums">
          {Math.floor(workedMin / 60)
            .toString()
            .padStart(2, "0")}
          :{(workedMin % 60).toString().padStart(2, "0")}
        </div>
        <div className="text-sm text-muted-foreground">trabalhado hoje</div>

        {nextTipo ? (
          <Button size="lg" className="w-full text-lg h-14" onClick={bater}>
            Bater: {LABEL[nextTipo].label}
          </Button>
        ) : (
          <div className="rounded-md bg-primary-muted p-4 text-sm">
            ✓ Jornada do dia completa.
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Batidas de hoje
        </h2>
        {!todayEntries?.length && (
          <div className="text-sm text-muted-foreground">
            Nenhuma batida ainda.
          </div>
        )}
        <div className="space-y-1.5">
          {todayEntries?.map((e) => {
            const meta = LABEL[e.tipo];
            const Icon = meta?.icon ?? Clock;
            return (
              <div
                key={e.id}
                className="flex items-center justify-between rounded-md border border-border p-3 text-sm"
              >
                <div className="flex items-center gap-2.5">
                  <Icon className="size-4 text-primary" />
                  <span className="font-medium">{meta?.label ?? e.tipo}</span>
                </div>
                <span className="font-mono text-muted-foreground">
                  {new Date(e.entry_at).toLocaleTimeString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
