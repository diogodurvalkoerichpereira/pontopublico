import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Settings, Mail, Send, Save } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getEmailSettings,
  saveEmailSettings,
  sendTestEmail,
} from "@/lib/data.functions";

export const Route = createFileRoute("/admin/configuracoes")({
  component: Page,
});

function Page() {
  const { session, isAdmin, loading } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) nav({ to: "/login" });
    else if (!isAdmin) {
      toast.error("Apenas administradores");
      nav({ to: "/app" });
    }
  }, [session, isAdmin, loading, nav]);
  if (!session || !isAdmin) return null;
  return (
    <AppShell>
      <Content />
    </AppShell>
  );
}

type Form = {
  enabled: boolean;
  notify_on_release: boolean;
  from_name: string;
  from_email: string;
  smtp_host: string;
  smtp_port: string;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_password: string;
};

function Content() {
  const loadFn = useServerFn(getEmailSettings);
  const saveFn = useServerFn(saveEmailSettings);
  const testFn = useServerFn(sendTestEmail);

  const [form, setForm] = useState<Form | null>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);

  const { data } = useQuery({
    queryKey: ["email-settings"],
    queryFn: async () => (await loadFn()) as Record<string, unknown> | null,
  });

  useEffect(() => {
    if (data === undefined) return;
    const d = (data ?? {}) as Record<string, unknown>;
    setForm({
      enabled: Boolean(d.enabled),
      notify_on_release:
        d.notify_on_release === undefined ? true : Boolean(d.notify_on_release),
      from_name: (d.from_name as string) ?? "Meu Ponto",
      from_email: (d.from_email as string) ?? "meuponto@empresa.com.br",
      smtp_host: (d.smtp_host as string) ?? "",
      smtp_port: d.smtp_port != null ? String(d.smtp_port) : "587",
      smtp_secure: Boolean(d.smtp_secure),
      smtp_user: (d.smtp_user as string) ?? "",
      smtp_password: "",
    });
    setHasPassword(Boolean((d as { has_password?: boolean }).has_password));
  }, [data]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await saveFn({
        data: {
          enabled: form.enabled,
          notify_on_release: form.notify_on_release,
          from_name: form.from_name,
          from_email: form.from_email,
          smtp_host: form.smtp_host,
          smtp_port: Number(form.smtp_port) || 587,
          smtp_secure: form.smtp_secure,
          smtp_user: form.smtp_user,
          // só envia a senha se foi digitada (senão mantém a atual)
          ...(form.smtp_password ? { smtp_password: form.smtp_password } : {}),
        },
      });
      toast.success("Configurações salvas");
      if (form.smtp_password) setHasPassword(true);
      setForm({ ...form, smtp_password: "" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const enviarTeste = async () => {
    if (!testTo) {
      toast.error("Informe um e-mail para o teste");
      return;
    }
    setTesting(true);
    try {
      await testFn({ data: { to: testTo } });
      toast.success(`E-mail de teste enviado para ${testTo}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao enviar teste");
    } finally {
      setTesting(false);
    }
  };

  if (!form)
    return (
      <div className="p-10 text-center text-muted-foreground">
        Carregando...
      </div>
    );

  return (
    <section className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Settings className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            Configurações
          </h1>
          <p className="text-sm text-muted-foreground">
            Ajustes gerais do sistema (acesso restrito ao administrador).
          </p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-2xl p-5 md:p-6 shadow-sm space-y-5">
        <div className="flex items-center gap-2">
          <Mail className="size-4 text-primary" />
          <h2 className="font-bold text-sm uppercase tracking-widest text-muted-foreground">
            Notificações por e-mail
          </h2>
        </div>

        <Toggle
          label="Ativar envio de e-mails"
          checked={form.enabled}
          onChange={(v) => setForm({ ...form, enabled: v })}
        />
        <Toggle
          label="Notificar o colaborador quando o acesso for liberado (após cadastro)"
          checked={form.notify_on_release}
          onChange={(v) => setForm({ ...form, notify_on_release: v })}
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <Field
            label="Nome do remetente"
            value={form.from_name}
            onChange={(v) => setForm({ ...form, from_name: v })}
          />
          <Field
            label="E-mail do remetente"
            value={form.from_email}
            onChange={(v) => setForm({ ...form, from_email: v })}
            placeholder="meuponto@empresa.com.br"
          />
          <Field
            label="Servidor SMTP (host)"
            value={form.smtp_host}
            onChange={(v) => setForm({ ...form, smtp_host: v })}
            placeholder="smtp.empresa.com.br"
          />
          <Field
            label="Porta"
            type="number"
            value={form.smtp_port}
            onChange={(v) => setForm({ ...form, smtp_port: v })}
            placeholder="587"
          />
          <Field
            label="Usuário SMTP"
            value={form.smtp_user}
            onChange={(v) => setForm({ ...form, smtp_user: v })}
            placeholder="meuponto@empresa.com.br"
          />
          <Field
            label={`Senha SMTP${hasPassword ? " (definida — preencha só para trocar)" : ""}`}
            type="password"
            value={form.smtp_password}
            onChange={(v) => setForm({ ...form, smtp_password: v })}
            placeholder={hasPassword ? "•••••••• (mantém a atual)" : ""}
          />
          <Toggle
            label="Conexão segura (SSL/TLS — porta 465)"
            checked={form.smtp_secure}
            onChange={(v) => setForm({ ...form, smtp_secure: v })}
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            <Save className="size-4 mr-2" />{" "}
            {saving ? "Salvando..." : "Salvar configurações"}
          </Button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-2xl p-5 md:p-6 shadow-sm space-y-3">
        <h2 className="font-bold text-sm uppercase tracking-widest text-muted-foreground">
          Enviar e-mail de teste
        </h2>
        <p className="text-xs text-muted-foreground">
          Usa as configurações salvas acima. Salve antes de testar.
        </p>
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[220px] space-y-1.5">
            <Label className="text-[11px] font-bold uppercase text-muted-foreground">
              Enviar para
            </Label>
            <Input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="seu-email@empresa.com.br"
            />
          </div>
          <Button variant="outline" onClick={enviarTeste} disabled={testing}>
            <Send className="size-4 mr-2" />{" "}
            {testing ? "Enviando..." : "Enviar teste"}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Observação: a caixa de e-mail <strong>meuponto@empresa.com.br</strong>{" "}
        precisa existir no provedor de e-mail da empresa (Google Workspace,
        Microsoft 365 ou servidor próprio). Aqui você informa o SMTP dessa conta
        para o sistema enviar as mensagens.
      </p>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-bold uppercase text-muted-foreground">
        {label}
      </Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-primary"
      />
      <span className="text-sm font-medium">{label}</span>
    </label>
  );
}
