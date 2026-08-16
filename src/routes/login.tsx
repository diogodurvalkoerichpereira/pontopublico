import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

const schema = z.object({
  email: z.string().email("E-mail inválido").max(255),
  password: z.string().min(12, "Mínimo 12 caracteres").max(72),
  fullName: z.string().min(2).max(100).optional(),
  matricula: z.string().max(50).optional(),
});

function LoginPage() {
  const { session, isAdmin, isRh, loading } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [matricula, setMatricula] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && session) {
      nav({ to: isAdmin ? "/admin/usuarios" : isRh ? "/rh" : "/app" });
    }
  }, [session, isAdmin, isRh, loading, nav]);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = schema.safeParse({
      email,
      password,
      fullName: fullName || undefined,
      matricula: matricula || undefined,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: { full_name: fullName, matricula },
          },
        });
        if (error) throw error;
        toast.success("Conta criada! Você já pode entrar.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Falha ao autenticar";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
      style={{
        background: "linear-gradient(135deg, #1e293b 0%, #334155 100%)",
      }}
    >
      <div
        className="flex w-full overflow-hidden bg-white"
        style={{
          maxWidth: 820,
          borderRadius: 18,
          boxShadow: "0 32px 64px rgba(0,0,0,0.35)",
          minHeight: 480,
        }}
      >
        {/* Painel esquerdo — marca do produto */}
        <div
          className="hidden flex-col items-center justify-center gap-5 px-10 py-12 text-center md:flex"
          style={{
            width: "40%",
            background: "linear-gradient(160deg, #2563eb 0%, #1d4ed8 100%)",
          }}
        >
          <span
            className="text-3xl font-bold tracking-tight text-white"
            style={{ textShadow: "0 2px 6px rgba(0,0,0,.2)" }}
          >
            Meu Ponto
          </span>
          <h1 className="text-xl font-bold leading-snug text-white">
            Atestados médicos
            <br />
            sem digitação manual
          </h1>
          <p className="text-sm leading-relaxed text-white/90">
            Envie o atestado médico e acompanhe a aprovação do RH em um só
            lugar.
          </p>
          <div className="mt-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-widest text-white/60">
            <ShieldCheck className="size-3.5" />
            Conformidade LGPD
          </div>
        </div>

        {/* Painel direito — formulário */}
        <div className="flex flex-1 flex-col justify-center px-8 py-12 sm:px-12">
          <div className="mb-8 space-y-1.5">
            <h2
              className="text-2xl font-bold tracking-tight"
              style={{ color: "#1e293b" }}
            >
              {mode === "login" ? "Acesso ao Meu Ponto" : "Criar conta"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {mode === "login"
                ? "Entre com suas credenciais corporativas"
                : "Cadastre-se como funcionário"}
            </p>
          </div>

          <form onSubmit={handle} className="space-y-4 animate-in-up">
            {mode === "signup" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="fn">Nome completo</Label>
                  <Input
                    id="fn"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mt">Matrícula (opcional)</Label>
                  <Input
                    id="mt"
                    value={matricula}
                    onChange={(e) => setMatricula(e.target.value)}
                    maxLength={50}
                  />
                </div>
              </>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="em">E-mail corporativo</Label>
              <Input
                id="em"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={255}
                placeholder="voce@empresa.com.br"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw">Senha</Label>
              <Input
                id="pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
                maxLength={72}
                placeholder="••••••••••••"
              />
              {mode === "signup" && (
                <p className="text-[11px] text-muted-foreground">
                  Use 12 caracteres ou mais, com maiúscula, minúscula, número e
                  símbolo.
                </p>
              )}
            </div>

            <Button
              type="submit"
              disabled={submitting}
              className="w-full font-semibold"
            >
              {submitting
                ? "Aguarde..."
                : mode === "login"
                  ? "Entrar"
                  : "Criar conta"}
            </Button>

            <button
              type="button"
              onClick={() => setMode(mode === "login" ? "signup" : "login")}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
            >
              {mode === "login"
                ? "Não tem conta? Cadastre-se"
                : "Já tem conta? Entrar"}
            </button>
          </form>

          <p className="mt-8 text-center text-[10px] uppercase tracking-widest text-muted-foreground/60">
            Portal RH · Meu Ponto
          </p>
        </div>
      </div>
    </div>
  );
}
