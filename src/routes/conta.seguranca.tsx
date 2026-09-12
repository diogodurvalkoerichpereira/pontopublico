import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ShieldCheck, ShieldOff, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import {
  getMfaStatus,
  startMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
} from "@/lib/mfa.functions";

export const Route = createFileRoute("/conta/seguranca")({ component: Page });

function OtpField({
  value,
  onChange,
  onComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: () => void;
}) {
  return (
    <InputOTP
      maxLength={6}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
    >
      <InputOTPGroup>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <InputOTPSlot key={i} index={i} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}

function Page() {
  const statusFn = useServerFn(getMfaStatus);
  const startFn = useServerFn(startMfaEnrollment);
  const confirmFn = useServerFn(confirmMfaEnrollment);
  const disableFn = useServerFn(disableMfa);
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["mfa-status"],
    queryFn: () => statusFn(),
  });

  const [enrolling, setEnrolling] = useState<{
    secret: string;
    otpauthUri: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disableCode, setDisableCode] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["mfa-status"] });

  const start = async () => {
    setBusy(true);
    try {
      const res = await startFn();
      setEnrolling(res);
      setCode("");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Falha ao iniciar o cadastro",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (code.length !== 6) return;
    setBusy(true);
    try {
      const res = await confirmFn({ data: { code } });
      setBackupCodes(res.backupCodes);
      setEnrolling(null);
      setCode("");
      await refresh();
      toast.success("Segundo fator ativado");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Código inválido");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (disableCode.length !== 6) return;
    setBusy(true);
    try {
      await disableFn({ data: { code: disableCode } });
      setDisableCode("");
      await refresh();
      toast.success("Segundo fator desativado");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Código inválido");
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    if (!enrolling) return;
    try {
      await navigator.clipboard.writeText(enrolling.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Não foi possível copiar");
    }
  };

  return (
    <AppShell>
      <section className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-extrabold">
            <ShieldCheck />
            Segurança da conta
          </h1>
          <p className="text-sm text-muted-foreground">
            Ative a verificação em duas etapas (TOTP). Operações de alto risco —
            fechar ou reabrir folha e administrar papéis de acesso — passam a
            exigir um código do seu aplicativo autenticador.
          </p>
        </div>

        {/* Códigos de recuperação — mostrados uma única vez após confirmar. */}
        {backupCodes && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5">
            <b className="text-amber-900">
              Guarde seus códigos de recuperação agora
            </b>
            <p className="mt-1 text-sm text-amber-800">
              Cada código serve uma única vez, caso você perca o acesso ao
              aplicativo. Eles não serão mostrados novamente.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm">
              {backupCodes.map((c) => (
                <span
                  key={c}
                  className="rounded border bg-white px-2 py-1 text-center"
                >
                  {c}
                </span>
              ))}
            </div>
            <Button className="mt-4" onClick={() => setBackupCodes(null)}>
              Já guardei os códigos
            </Button>
          </div>
        )}

        {/* Estado ativo. */}
        {status?.enrolled && !enrolling && (
          <div className="rounded-2xl border bg-card p-5">
            <p className="flex items-center gap-2 font-semibold text-green-700">
              <ShieldCheck className="size-5" />
              Verificação em duas etapas ativada
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {status.sessionMfaBacked
                ? "Esta sessão já está verificada."
                : "Você fará a verificação ao executar a próxima operação de alto risco."}
            </p>
            <div className="mt-4 space-y-2 border-t pt-4">
              <p className="text-sm font-medium">
                Para desativar, confirme com um código atual:
              </p>
              <OtpField
                value={disableCode}
                onChange={setDisableCode}
                onComplete={disable}
              />
              <Button
                variant="destructive"
                onClick={disable}
                disabled={busy || disableCode.length !== 6}
              >
                <ShieldOff className="mr-1 size-4" />
                Desativar
              </Button>
            </div>
          </div>
        )}

        {/* Não inscrito e sem inscrição em andamento. */}
        {!status?.enrolled && !enrolling && (
          <div className="rounded-2xl border bg-card p-5">
            <p className="text-sm text-muted-foreground">
              A verificação em duas etapas ainda não está ativada nesta conta.
            </p>
            <Button className="mt-4" onClick={start} disabled={busy}>
              Ativar verificação em duas etapas
            </Button>
          </div>
        )}

        {/* Inscrição em andamento: mostrar segredo e confirmar com um código. */}
        {enrolling && (
          <div className="rounded-2xl border bg-card p-5">
            <b>1. Cadastre no aplicativo autenticador</b>
            <p className="mt-1 text-sm text-muted-foreground">
              Abra o Google Authenticator, Aegis, 1Password ou similar e
              adicione uma conta com a chave abaixo (ou pela URI otpauth).
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 break-all rounded border bg-muted px-3 py-2 font-mono text-sm">
                {enrolling.secret}
              </code>
              <Button variant="outline" size="sm" onClick={copySecret}>
                {copied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
            <p className="mt-2 break-all text-xs text-muted-foreground">
              {enrolling.otpauthUri}
            </p>

            <b className="mt-5 block">2. Confirme com o código gerado</b>
            <div className="mt-2 flex flex-col gap-3">
              <OtpField value={code} onChange={setCode} onComplete={confirm} />
              <div className="flex gap-2">
                <Button onClick={confirm} disabled={busy || code.length !== 6}>
                  Confirmar e ativar
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setEnrolling(null)}
                  disabled={busy}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>
    </AppShell>
  );
}
