// Challenge de segundo fator (O0-09). Uso contido nos pontos que disparam uma
// operação de alto risco: envolva a chamada com `ensure(...)`. Se o servidor
// lançar MFA_REQUIRED, abre um modal com TOTP, chama verifyMfa e repete a ação.
// Não é um wrapper global — cada tela decide onde aplicar.
import * as React from "react";
import { useServerFn } from "@tanstack/react-start";
import { verifyMfa } from "@/lib/mfa.functions";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Button } from "@/components/ui/button";

export function isMfaRequired(error: unknown): boolean {
  return error instanceof Error && /MFA_REQUIRED/.test(error.message);
}

export function useMfaChallenge() {
  const verify = useServerFn(verifyMfa);
  const [open, setOpen] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Resolve/rejeita a promessa de `ensure` conforme o desfecho do modal.
  const pending = React.useRef<{
    resolve: () => void;
    reject: (e: unknown) => void;
  } | null>(null);

  /**
   * Executa `action`. Se falhar por MFA_REQUIRED, abre o challenge e, após a
   * verificação, executa `action` de novo (agora a sessão está MFA-backed).
   * Qualquer outro erro é repassado ao chamador.
   */
  const ensure = React.useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (!isMfaRequired(err)) throw err;
        await new Promise<void>((resolve, reject) => {
          pending.current = { resolve, reject };
          setCode("");
          setError(null);
          setOpen(true);
        });
        return action();
      }
    },
    [],
  );

  const submit = async () => {
    if (code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      await verify({ data: { code } });
      setOpen(false);
      pending.current?.resolve();
      pending.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Código inválido");
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setOpen(false);
    pending.current?.reject(new Error("Verificação de MFA cancelada"));
    pending.current = null;
  };

  const dialog = (
    <Dialog open={open} onOpenChange={(v) => !v && cancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirmação em duas etapas</DialogTitle>
          <DialogDescription>
            Esta é uma operação de alto risco. Informe o código de 6 dígitos do
            seu aplicativo autenticador para continuar.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          <InputOTP
            maxLength={6}
            value={code}
            onChange={setCode}
            autoFocus
            onComplete={submit}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <InputOTPSlot key={i} index={i} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={cancel} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={busy || code.length !== 6}>
            {busy ? "Verificando..." : "Confirmar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { ensure, dialog };
}
