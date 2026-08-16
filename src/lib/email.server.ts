// Envio de e-mail via SMTP (nodemailer). SOMENTE servidor.
import nodemailer from "nodemailer";
import { queryOne } from "./db.server";

export interface EmailSettings {
  id: string;
  enabled: boolean;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  smtp_user: string | null;
  smtp_password: string | null;
  from_email: string | null;
  from_name: string | null;
  notify_on_release: boolean;
}

const APP_URL = process.env.APP_URL || "http://localhost:8080/";

export async function loadEmailSettings(): Promise<EmailSettings | null> {
  return queryOne<EmailSettings>(
    "SELECT * FROM public.email_settings ORDER BY updated_at LIMIT 1",
  );
}

function transportFrom(s: EmailSettings) {
  if (!s.smtp_host) throw new Error("SMTP não configurado (informe o host).");
  return nodemailer.createTransport({
    host: s.smtp_host,
    port: s.smtp_port || 587,
    secure: !!s.smtp_secure,
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_password || "" } : undefined,
  });
}

export async function sendMailWith(s: EmailSettings, to: string, subject: string, html: string): Promise<void> {
  const transport = transportFrom(s);
  const from = s.from_name ? `"${s.from_name}" <${s.from_email}>` : (s.from_email || s.smtp_user || "");
  await transport.sendMail({ from, to, subject, html });
}

function escapeHtml(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** E-mail de liberação de acesso ao colaborador. */
export function releaseEmail(name: string, loginEmail: string, password?: string | null): { subject: string; html: string } {
  const senha = password
    ? `<p style="margin:6px 0"><strong>Senha inicial:</strong> ${escapeHtml(password)}<br/>
        <span style="color:#888;font-size:13px">Recomendamos alterá-la no primeiro acesso.</span></p>`
    : `<p style="margin:6px 0">A senha foi definida pelo RH.</p>`;
  return {
    subject: "Seu acesso ao Meu Ponto foi liberado",
    html: `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:540px;margin:0 auto;color:#1f2937">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#1e293b;border-radius:8px 8px 0 0">
        <tr>
          <td width="44" style="padding:16px 0 16px 20px;vertical-align:middle">
            <div style="width:44px;height:44px;background:#2563eb;border-radius:8px;text-align:center;line-height:44px;font-family:Arial,Helvetica,sans-serif;font-weight:bold;color:#ffffff;font-size:15px">MP</div>
          </td>
          <td style="padding:16px 20px 16px 12px;vertical-align:middle;font-family:Arial,Helvetica,sans-serif">
            <div style="font-size:17px;font-weight:bold;color:#ffffff;line-height:1.2">Meu Ponto</div>
            <div style="font-size:12px;color:#c7d2df;margin-top:2px">Notificação de acesso liberado</div>
          </td>
        </tr>
      </table>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 8px 8px">
        <p>Olá, <strong>${escapeHtml(name || "colaborador(a)")}</strong>!</p>
        <p>Seu acesso ao sistema <strong>Meu Ponto</strong> foi liberado. Você já pode entrar e:</p>
        <ul style="margin:6px 0 12px;padding-left:20px">
          <li>registrar o seu ponto;</li>
          <li>enviar seus documentos de admissão;</li>
          <li>enviar atestados médicos.</li>
        </ul>
        <p style="margin:6px 0"><strong>Endereço:</strong> <a href="${APP_URL}" style="color:#2563eb">${APP_URL}</a><br/>
           <strong>Login (e-mail):</strong> ${escapeHtml(loginEmail)}</p>
        ${senha}
        <hr style="border:none;border-top:1px solid #eee;margin:18px 0"/>
        <p style="color:#9ca3af;font-size:12px">Mensagem automática — não responda a este e-mail.</p>
      </div>
    </div>`,
  };
}

export function testEmail(): { subject: string; html: string } {
  return {
    subject: "Teste de configuração — Meu Ponto",
    html: `<div style="font-family:Arial,sans-serif;color:#1e293b">
      <p>✅ Este é um e-mail de teste do <strong>Meu Ponto</strong>.</p>
      <p>Se você recebeu esta mensagem, o envio por SMTP está funcionando.</p>
    </div>`,
  };
}
