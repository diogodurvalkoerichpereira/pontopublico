// Server functions que substituem a API do Supabase (PostgREST + Auth + Storage).
import { createServerFn, createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { join, normalize } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { query, queryOne, withTransaction } from "./db.server";
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  assertStrongPassword,
  TOKEN_TTL,
} from "./auth.server";
import { runQuery, loadAccess } from "./pgrest.server";
import { loadTenantAccess } from "./tenant-access.server";
import {
  loadEmailSettings,
  sendMailWith,
  releaseEmail,
  testEmail,
} from "./email.server";
import type { QueryReq } from "./pgrest-types";

const STORAGE_DIR = process.env.STORAGE_DIR || "/data/storage";
const ALLOWED_BUCKETS = new Set(["atestados", "documentos-funcionarios"]);
// E-mails promovidos automaticamente a admin no cadastro.
// Configurável por ambiente: ADMIN_EMAILS="a@x.com,b@x.com"
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "admin@example.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const DUMMY_PASSWORD_HASH =
  "scrypt$0123456789abcdef0123456789abcdef$2dd5076a400f08156c9ea074203036b9010784c0636fcf1883957f8bc4e0bc338e03b94563c926e8d459c9198e8db48b557e239992a1ab801bad7fb652f2bdca";

function requestFingerprint() {
  const request = getRequest();
  const ip =
    request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request?.headers?.get("x-real-ip") ||
    "unknown";
  const userAgent = (request?.headers?.get("user-agent") || "unknown").slice(
    0,
    500,
  );
  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  return { ipHash: digest(ip), userAgent };
}

async function bearerUserId(): Promise<{
  userId: string;
  email: string;
  sessionId: string;
  mfaVerifiedAt: string | null;
}> {
  const request = getRequest();
  const authHeader = request?.headers?.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) throw new Error("Unauthorized");
  const token = authHeader.slice(7);
  const claims = verifyToken(token);
  if (!claims?.sub || !claims.sid) throw new Error("Unauthorized");
  const session = await queryOne<{
    id: string;
    mfa_verified_at: string | null;
  }>(
    `select id, mfa_verified_at::text from private.auth_sessions
     where id=$1 and user_id=$2 and revoked_at is null and expires_at>now()`,
    [claims.sid, claims.sub],
  );
  if (!session) throw new Error("Unauthorized: session expired or revoked");
  await query(
    `update private.auth_sessions set last_seen_at=now()
     where id=$1 and last_seen_at < now()-interval '5 minutes'`,
    [claims.sid],
  );
  return {
    userId: claims.sub,
    email: claims.email,
    sessionId: claims.sid,
    mfaVerifiedAt: session.mfa_verified_at,
  };
}

export const requireAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const { userId, email, sessionId, mfaVerifiedAt } = await bearerUserId();
    return next({ context: { userId, email, sessionId, mfaVerifiedAt } });
  },
);

// ---------- Query genérica autorizada ----------
export const dbQuery = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => d as QueryReq)
  .handler(async ({ data, context }) => {
    const ctx = await loadAccess(context.userId);
    // O tenant vem do cliente (shim), então não pode ser confiado cru: só é
    // aceito depois de loadTenantAccess confirmar associação ativa em
    // tenant_memberships, que lança se o usuário não for membro daquele ente.
    // Um tenant_id de outro ente falha aqui, antes de tocar o compilador.
    let tenantId: string | null = null;
    if (data.tenant_id) {
      await loadTenantAccess(context.userId, data.tenant_id);
      tenantId = data.tenant_id;
    }
    return runQuery(data, ctx, tenantId);
  });

// ---------- Auth ----------
const SignUpInput = z.object({
  email: z.string().email().max(255),
  password: z.string().min(12).max(72),
  full_name: z.string().max(255).optional().default(""),
  matricula: z.string().max(50).optional().default(""),
  cpf: z.string().max(20).optional().default(""),
  setor: z.string().max(100).optional().default(""),
});

async function sessionFor(
  id: string,
  email: string,
  meta: Record<string, unknown>,
) {
  const sid = randomUUID();
  const { ipHash, userAgent } = requestFingerprint();
  await query(
    `insert into private.auth_sessions
       (id,user_id,expires_at,ip_hash,user_agent)
     values ($1,$2,now()+($3||' seconds')::interval,$4,$5)`,
    [sid, id, TOKEN_TTL, ipHash, userAgent],
  );
  const access_token = signToken(id, email, sid);
  return {
    access_token,
    token_type: "bearer",
    user: { id, email, user_metadata: meta },
  };
}

export const signUp = createServerFn({ method: "POST" })
  .validator((d: unknown) => SignUpInput.parse(d))
  .handler(async ({ data }) => {
    assertStrongPassword(data.password);
    const email = data.email.toLowerCase();
    const existing = await queryOne<{ id: string }>(
      "SELECT id FROM public.app_users WHERE lower(email) = $1",
      [email],
    );
    if (existing) return { error: "E-mail já cadastrado" };

    const meta = {
      full_name: data.full_name,
      cpf: data.cpf,
      matricula: data.matricula,
      setor: data.setor,
    };
    const id = randomUUID();
    const passwordHash = hashPassword(data.password);
    const isAdminEmail = ADMIN_EMAILS.includes(email);

    await withTransaction(async (client) => {
      await client.query(
        "INSERT INTO public.app_users (id, email, password_hash, raw_user_meta_data) VALUES ($1,$2,$3,$4)",
        [id, data.email, passwordHash, JSON.stringify(meta)],
      );
      await client.query(
        `INSERT INTO public.profiles (id, full_name, email, cpf, matricula, setor)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          data.full_name || "",
          data.email,
          data.cpf || "",
          data.matricula || "",
          data.setor || "",
        ],
      );
      const cpfDigits = data.cpf.replace(/\D/g, "");
      const existingPerson =
        cpfDigits.length === 11
          ? await client.query<{ id: string }>(
              `SELECT id FROM public.persons
             WHERE regexp_replace(cpf, '\\D', '', 'g') = $1 LIMIT 1`,
              [cpfDigits],
            )
          : null;
      const personId = existingPerson?.rows[0]?.id ?? id;
      if (!existingPerson?.rows[0]) {
        await client.query(
          `INSERT INTO public.persons (id, cpf, full_name, personal_email)
           VALUES ($1,$2,$3,$4)`,
          [
            personId,
            cpfDigits.length === 11 ? data.cpf : null,
            data.full_name || data.email,
            data.email,
          ],
        );
      }
      await client.query(
        "UPDATE public.profiles SET person_id=$2 WHERE id=$1",
        [id, personId],
      );
      await client.query(
        "INSERT INTO public.user_roles (user_id, role) VALUES ($1,'funcionario') ON CONFLICT DO NOTHING",
        [id],
      );
      if (isAdminEmail) {
        await client.query(
          "INSERT INTO public.user_roles (user_id, role) VALUES ($1,'rh'),($1,'admin') ON CONFLICT DO NOTHING",
          [id],
        );
      }
      const tenantResult = await client.query<{ id: string }>(
        "SELECT id FROM public.tenants WHERE status = 'ativo' ORDER BY created_at, id LIMIT 1",
      );
      const tenantId = tenantResult.rows[0]?.id;
      if (tenantId) {
        await client.query(
          `INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_default)
           VALUES ($1,$2,'ativo',true) ON CONFLICT (tenant_id, user_id) DO NOTHING`,
          [tenantId, id],
        );
        await client.query(
          `INSERT INTO public.security_user_roles (tenant_id, user_id, role_id, created_by)
           SELECT $1, $2, id, $2 FROM public.security_roles
           WHERE tenant_id = $1 AND codigo = $3
           ON CONFLICT DO NOTHING`,
          [tenantId, id, isAdminEmail ? "tenant_admin" : "employee"],
        );
        await client.query(
          `INSERT INTO public.employment_links
             (tenant_id, person_id, source_profile_id, registration_number, status)
           VALUES ($1,$2,$3,$4,'rascunho')
           ON CONFLICT (tenant_id, source_profile_id) WHERE source_profile_id IS NOT NULL DO NOTHING`,
          [
            tenantId,
            personId,
            id,
            data.matricula || `USER-${id.slice(0, 8).toUpperCase()}`,
          ],
        );
      }
    });

    return { error: null, session: await sessionFor(id, data.email, meta) };
  });

const SignInInput = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(72),
});

export const signIn = createServerFn({ method: "POST" })
  .validator((d: unknown) => SignInInput.parse(d))
  .handler(async ({ data }) => {
    const identifier = data.email.trim().toLowerCase();
    const { ipHash } = requestFingerprint();
    const identifierHash = createHash("sha256")
      .update(identifier, "utf8")
      .digest("hex");
    const recentFailures = await queryOne<{ total: number }>(
      `select count(*)::int as total from private.auth_login_attempts
       where identifier_hash=$1 and ip_hash=$2 and not succeeded
         and attempted_at>now()-interval '15 minutes'`,
      [identifierHash, ipHash],
    );
    if ((recentFailures?.total ?? 0) >= 5)
      return {
        error:
          "Acesso temporariamente bloqueado. Tente novamente em 15 minutos.",
      };
    const user = await queryOne<{
      id: string;
      email: string;
      password_hash: string;
      raw_user_meta_data: Record<string, unknown>;
      failed_login_attempts: number;
      locked_until: string | null;
    }>(
      `select id,email,password_hash,raw_user_meta_data,failed_login_attempts,
         locked_until::text
       from public.app_users where lower(email)=$1`,
      [identifier],
    );
    if (user?.locked_until && new Date(user.locked_until) > new Date())
      return {
        error: "Acesso temporariamente bloqueado. Tente novamente mais tarde.",
      };
    const passwordValid = verifyPassword(
      data.password,
      user?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !passwordValid) {
      await withTransaction(async (client) => {
        await client.query(
          `insert into private.auth_login_attempts
             (identifier_hash,ip_hash,succeeded) values ($1,$2,false)`,
          [identifierHash, ipHash],
        );
        if (user) {
          await client.query(
            `update public.app_users set failed_login_attempts=failed_login_attempts+1,
               locked_until=case when failed_login_attempts+1>=5
                 then now()+interval '15 minutes' else null end,
               updated_at=now() where id=$1`,
            [user.id],
          );
        }
      });
      return { error: "E-mail ou senha inválidos" };
    }
    await withTransaction(async (client) => {
      await client.query(
        `insert into private.auth_login_attempts
           (identifier_hash,ip_hash,succeeded) values ($1,$2,true)`,
        [identifierHash, ipHash],
      );
      await client.query(
        `update public.app_users set failed_login_attempts=0,locked_until=null,
           last_login_at=now(),updated_at=now() where id=$1`,
        [user.id],
      );
      await client.query(
        "delete from private.auth_login_attempts where attempted_at<now()-interval '24 hours'",
      );
    });
    return {
      error: null,
      session: await sessionFor(
        user.id,
        user.email,
        user.raw_user_meta_data ?? {},
      ),
    };
  });

export const signOutSession = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    await query(
      "update private.auth_sessions set revoked_at=now() where id=$1 and user_id=$2",
      [context.sessionId, context.userId],
    );
    return { error: null };
  });

// ---------- Storage ----------
function safeStoragePath(bucket: string, path: string): string {
  if (!ALLOWED_BUCKETS.has(bucket)) throw new Error("Bucket inválido");
  const clean = normalize(path).replace(/^(\.\.(\/|\\|$))+/, "");
  if (clean.includes("..")) throw new Error("Caminho inválido");
  return join(STORAGE_DIR, bucket, clean);
}

const UploadInput = z.object({
  bucket: z.string().max(64),
  path: z.string().max(512),
  base64: z.string().min(1),
  contentType: z.string().max(128).optional(),
});

export const storageUpload = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => UploadInput.parse(d))
  .handler(async ({ data, context }) => {
    // Usuário só pode enviar para a própria pasta (path começa com <userId>/)
    if (!data.path.startsWith(`${context.userId}/`)) {
      return { error: "Caminho não autorizado" };
    }
    const full = safeStoragePath(data.bucket, data.path);
    await fs.mkdir(join(full, ".."), { recursive: true });
    await fs.writeFile(full, Buffer.from(data.base64, "base64"));
    return { error: null, path: data.path };
  });

const DownloadInput = z.object({
  bucket: z.string().max(64),
  path: z.string().max(512),
});

export const storageDownload = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => DownloadInput.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = await loadAccess(context.userId);
    const isRh = ctx.roles.includes("rh") || ctx.roles.includes("admin");
    const ownsPath = data.path.startsWith(`${context.userId}/`);
    if (!ownsPath && !isRh) return { error: "Acesso negado" };
    try {
      const full = safeStoragePath(data.bucket, data.path);
      const buf = await fs.readFile(full);
      return { error: null, base64: buf.toString("base64") };
    } catch {
      return { error: "Arquivo não encontrado" };
    }
  });

// ---------- Admin (equivalente ao service_role) ----------
const AdminCreateInput = z.object({
  email: z.string().email().max(255),
  password: z.string().min(12).max(72),
  full_name: z.string().max(255),
  cpf: z.string().max(20).optional().default(""),
  matricula: z.string().max(50).optional().default(""),
  setor: z.string().max(100).optional().default(""),
  cargo: z.string().max(100).optional().default(""),
  role: z.enum(["funcionario", "rh", "admin"]),
  tenant_id: z.string().uuid().optional(),
});

export const adminCreateUser = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => AdminCreateInput.parse(d))
  .handler(async ({ data, context }) => {
    assertStrongPassword(data.password);
    const ctx = await loadAccess(context.userId);
    if (!ctx.roles.includes("admin")) throw new Error("Apenas administradores");

    const targetTenant = data.tenant_id
      ? await queryOne<{ id: string }>(
          `SELECT t.id FROM public.tenants t
           JOIN public.tenant_memberships tm ON tm.tenant_id = t.id
           WHERE t.id = $1 AND tm.user_id = $2 AND tm.status = 'ativo'`,
          [data.tenant_id, context.userId],
        )
      : await queryOne<{ id: string }>(
          `SELECT tm.tenant_id AS id FROM public.tenant_memberships tm
           WHERE tm.user_id = $1 AND tm.status = 'ativo'
           ORDER BY tm.is_default DESC, tm.created_at LIMIT 1`,
          [context.userId],
        );
    if (!targetTenant)
      throw new Error("Selecione uma entidade válida para o novo usuário");

    const email = data.email.toLowerCase();
    const existing = await queryOne<{ id: string }>(
      "SELECT id FROM public.app_users WHERE lower(email) = $1",
      [email],
    );
    if (existing) throw new Error("E-mail já cadastrado");

    const id = randomUUID();
    const meta = {
      full_name: data.full_name,
      cpf: data.cpf,
      matricula: data.matricula,
      setor: data.setor,
    };
    const passwordHash = hashPassword(data.password);

    await withTransaction(async (client) => {
      await client.query(
        "INSERT INTO public.app_users (id, email, password_hash, raw_user_meta_data) VALUES ($1,$2,$3,$4)",
        [id, data.email, passwordHash, JSON.stringify(meta)],
      );
      await client.query(
        `INSERT INTO public.profiles (id, full_name, email, cpf, matricula, setor, cargo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          data.full_name,
          data.email,
          data.cpf || null,
          data.matricula || null,
          data.setor || null,
          data.cargo || null,
        ],
      );
      const cpfDigits = data.cpf.replace(/\D/g, "");
      const existingPerson =
        cpfDigits.length === 11
          ? await client.query<{ id: string }>(
              `SELECT id FROM public.persons
             WHERE regexp_replace(cpf, '\\D', '', 'g') = $1 LIMIT 1`,
              [cpfDigits],
            )
          : null;
      const personId = existingPerson?.rows[0]?.id ?? id;
      if (!existingPerson?.rows[0]) {
        await client.query(
          `INSERT INTO public.persons (id, cpf, full_name, personal_email)
           VALUES ($1,$2,$3,$4)`,
          [
            personId,
            cpfDigits.length === 11 ? data.cpf : null,
            data.full_name,
            data.email,
          ],
        );
      }
      await client.query(
        "UPDATE public.profiles SET person_id=$2 WHERE id=$1",
        [id, personId],
      );
      await client.query(
        "INSERT INTO public.user_roles (user_id, role) VALUES ($1,'funcionario') ON CONFLICT DO NOTHING",
        [id],
      );
      if (data.role === "rh" || data.role === "admin") {
        await client.query(
          "INSERT INTO public.user_roles (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [id, data.role],
        );
      }
      if (data.role === "rh") {
        const perms = [
          "manage_employees",
          "approve_documents",
          "configure_schedules",
          "close_payroll",
        ];
        for (const p of perms) {
          await client.query(
            "INSERT INTO public.rh_permissions (user_id, permission) VALUES ($1,$2) ON CONFLICT DO NOTHING",
            [id, p],
          );
        }
      }
      await client.query(
        `INSERT INTO public.tenant_memberships (tenant_id, user_id, status, is_default)
         VALUES ($1,$2,'ativo',true) ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [targetTenant.id, id],
      );
      // RH novo recebe rh_operador (papel que materializa o RH legado, O0-10),
      // para não depender da ponte de compatibilidade em loadTenantAccess.
      const tenantRole =
        data.role === "admin"
          ? "tenant_admin"
          : data.role === "rh"
            ? "rh_operador"
            : "employee";
      await client.query(
        `INSERT INTO public.security_user_roles (tenant_id, user_id, role_id, created_by)
         SELECT $1, $2, id, $3 FROM public.security_roles
         WHERE tenant_id = $1 AND codigo = $4
         ON CONFLICT DO NOTHING`,
        [targetTenant.id, id, context.userId, tenantRole],
      );
      await client.query(
        `INSERT INTO public.employment_links
           (tenant_id, person_id, source_profile_id, registration_number, job_title, status)
         VALUES ($1,$2,$3,$4,$5,'rascunho')
         ON CONFLICT (tenant_id, source_profile_id) WHERE source_profile_id IS NOT NULL DO NOTHING`,
        [
          targetTenant.id,
          personId,
          id,
          data.matricula || `USER-${id.slice(0, 8).toUpperCase()}`,
          data.cargo || null,
        ],
      );
    });

    // Notifica o colaborador que o acesso foi liberado (não bloqueia a criação).
    try {
      const s = await loadEmailSettings();
      if (s?.enabled && s.notify_on_release && data.email) {
        const { subject, html } = releaseEmail(
          data.full_name,
          data.email,
          data.password,
        );
        await sendMailWith(s, data.email, subject, html);
      }
    } catch (e) {
      console.error("Falha ao enviar e-mail de liberação de acesso:", e);
    }

    return { id };
  });

// ---------- Configuração de e-mail (SMTP) — apenas admin ----------
async function requireAdmin(userId: string) {
  const ctx = await loadAccess(userId);
  if (!ctx.roles.includes("admin")) throw new Error("Apenas administradores");
}

export const getEmailSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const s = await loadEmailSettings();
    if (!s) return null;
    // Nunca devolve a senha em texto; só indica se está definida.
    return {
      enabled: s.enabled,
      smtp_host: s.smtp_host ?? "",
      smtp_port: s.smtp_port ?? 587,
      smtp_secure: s.smtp_secure,
      smtp_user: s.smtp_user ?? "",
      from_email: s.from_email ?? "",
      from_name: s.from_name ?? "",
      notify_on_release: s.notify_on_release,
      has_password: !!s.smtp_password,
    };
  });

const EmailSettingsInput = z.object({
  enabled: z.boolean(),
  smtp_host: z.string().max(255).optional().default(""),
  smtp_port: z.number().int().min(1).max(65535).optional().default(587),
  smtp_secure: z.boolean().optional().default(false),
  smtp_user: z.string().max(255).optional().default(""),
  smtp_password: z.string().max(255).optional(), // só atualiza se vier preenchida
  from_email: z.string().max(255).optional().default(""),
  from_name: z.string().max(255).optional().default(""),
  notify_on_release: z.boolean().optional().default(true),
});

export const saveEmailSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => EmailSettingsInput.parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const existing = await loadEmailSettings();
    const pw =
      data.smtp_password && data.smtp_password.length > 0
        ? data.smtp_password
        : null;
    if (existing) {
      await query(
        `UPDATE public.email_settings SET
           enabled=$1, smtp_host=$2, smtp_port=$3, smtp_secure=$4, smtp_user=$5,
           smtp_password=COALESCE($6, smtp_password), from_email=$7, from_name=$8,
           notify_on_release=$9, updated_at=now() WHERE id=$10`,
        [
          data.enabled,
          data.smtp_host || null,
          data.smtp_port || null,
          data.smtp_secure,
          data.smtp_user || null,
          pw,
          data.from_email || null,
          data.from_name || null,
          data.notify_on_release,
          existing.id,
        ],
      );
    } else {
      await query(
        `INSERT INTO public.email_settings
           (enabled, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, from_email, from_name, notify_on_release)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          data.enabled,
          data.smtp_host || null,
          data.smtp_port || null,
          data.smtp_secure,
          data.smtp_user || null,
          pw,
          data.from_email || null,
          data.from_name || null,
          data.notify_on_release,
        ],
      );
    }
    return { ok: true };
  });

const SendTestInput = z.object({ to: z.string().email() });
export const sendTestEmail = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => SendTestInput.parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const s = await loadEmailSettings();
    if (!s) throw new Error("Configuração de e-mail não encontrada");
    const { subject, html } = testEmail();
    await sendMailWith(s, data.to, subject, html);
    return { ok: true };
  });

const AdminResetPasswordInput = z.object({
  user_id: z.string().uuid(),
  password: z.string().min(12).max(72),
});

// Redefine a senha de um usuário. Permitido a admin ou RH com manage_employees.
// Trava de segurança: RH (não-admin) não pode redefinir senha de admin/RH
// (evita escalonamento de privilégio).
export const adminResetPassword = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => AdminResetPasswordInput.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = await loadAccess(context.userId);
    const isAdmin = ctx.roles.includes("admin");
    const canManage = isAdmin || ctx.perms.includes("manage_employees");
    if (!canManage) throw new Error("Sem permissão para redefinir senha");

    const target = await queryOne<{ id: string }>(
      "SELECT id FROM public.app_users WHERE id = $1",
      [data.user_id],
    );
    if (!target) throw new Error("Usuário não encontrado");

    if (!isAdmin) {
      const targetRoles = await query<{ role: string }>(
        "SELECT role FROM public.user_roles WHERE user_id = $1",
        [data.user_id],
      );
      const elevated = targetRoles.some(
        (r) => r.role === "admin" || r.role === "rh",
      );
      if (elevated)
        throw new Error(
          "RH não pode redefinir a senha de administradores ou de RH",
        );
    }

    const newPassword = data.password;
    assertStrongPassword(newPassword);
    const passwordHash = hashPassword(newPassword);
    await withTransaction(async (client) => {
      await client.query(
        `update public.app_users set password_hash=$1,password_changed_at=now(),
           force_password_change=true,failed_login_attempts=0,locked_until=null,
           updated_at=now() where id=$2`,
        [passwordHash, data.user_id],
      );
      await client.query(
        `update private.auth_sessions set revoked_at=now()
         where user_id=$1 and revoked_at is null`,
        [data.user_id],
      );
    });
    return { ok: true };
  });

const AdminUpdateEmailInput = z.object({
  user_id: z.string().uuid(),
  email: z.string().email().max(255),
});

// Altera o e-mail (login) de um usuário. Atualiza app_users E profiles em
// transação, garantindo unicidade. Permitido a admin ou RH com manage_employees.
// RH (não-admin) não pode alterar e-mail de admin/RH (evita hijack de conta).
export const adminUpdateUserEmail = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => AdminUpdateEmailInput.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = await loadAccess(context.userId);
    const isAdmin = ctx.roles.includes("admin");
    const canManage = isAdmin || ctx.perms.includes("manage_employees");
    if (!canManage) throw new Error("Sem permissão para alterar e-mail");

    const target = await queryOne<{ id: string }>(
      "SELECT id FROM public.app_users WHERE id = $1",
      [data.user_id],
    );
    if (!target) throw new Error("Usuário não encontrado");

    if (!isAdmin) {
      const targetRoles = await query<{ role: string }>(
        "SELECT role FROM public.user_roles WHERE user_id = $1",
        [data.user_id],
      );
      if (targetRoles.some((r) => r.role === "admin" || r.role === "rh"))
        throw new Error(
          "RH não pode alterar o e-mail de administradores ou de RH",
        );
    }

    const dup = await queryOne<{ id: string }>(
      "SELECT id FROM public.app_users WHERE lower(email) = lower($1) AND id <> $2",
      [data.email, data.user_id],
    );
    if (dup) throw new Error("E-mail já cadastrado para outro usuário");

    await withTransaction(async (client) => {
      await client.query(
        "UPDATE public.app_users SET email = $1, updated_at = now() WHERE id = $2",
        [data.email, data.user_id],
      );
      await client.query(
        "UPDATE public.profiles SET email = $1, updated_at = now() WHERE id = $2",
        [data.email, data.user_id],
      );
    });
    return { ok: true };
  });

// Inserção de documento de um colaborador PELO RH/admin (gestão de pessoas).
// Grava o arquivo na pasta do colaborador e cria o registro em employee_documents
// já como "aprovado" (o RH é a autoridade que anexou), registrando quem inseriu.
const RhUploadDocInput = z.object({
  user_id: z.string().uuid(),
  categoria: z.enum([
    "identificacao_pessoal",
    "trabalhista",
    "comprovante",
    "livre",
  ]),
  tipo: z.string().min(1).max(120),
  descricao: z.string().max(1000).optional().default(""),
  base64: z.string().min(1),
  mime: z.string().max(128).optional().default(""),
  ext: z.string().max(12).optional().default("bin"),
});

export const rhUploadEmployeeDocument = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => RhUploadDocInput.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = await loadAccess(context.userId);
    const isAdmin = ctx.roles.includes("admin");
    const canManage = isAdmin || ctx.perms.includes("manage_employees");
    if (!canManage) throw new Error("Sem permissão para inserir documentos");

    const target = await queryOne<{ id: string }>(
      "SELECT id FROM public.profiles WHERE id = $1",
      [data.user_id],
    );
    if (!target) throw new Error("Colaborador não encontrado");

    const safeExt =
      (data.ext || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "bin";
    const safeTipo =
      data.tipo.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40) || "documento";
    const path = `${data.user_id}/${Date.now()}-${safeTipo}.${safeExt}`;
    const full = safeStoragePath("documentos-funcionarios", path);
    await fs.mkdir(join(full, ".."), { recursive: true });
    await fs.writeFile(full, Buffer.from(data.base64, "base64"));

    const id = randomUUID();
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO public.employee_documents
           (id, user_id, categoria, tipo, descricao, arquivo_path, arquivo_mime, status, observacao_rh, reviewed_by, reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'aprovado',$8,$9, now())`,
        [
          id,
          data.user_id,
          data.categoria,
          data.tipo,
          data.descricao || null,
          path,
          data.mime || null,
          "Inserido pelo RH",
          context.userId,
        ],
      );
      await client.query(
        "UPDATE public.document_checklist SET document_id = $1 WHERE user_id = $2 AND tipo = $3",
        [id, data.user_id, data.tipo],
      );
    });
    return { ok: true, id, path };
  });

export const adminDeleteUser = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => z.object({ user_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const ctx = await loadAccess(context.userId);
    if (!ctx.roles.includes("admin")) throw new Error("Apenas administradores");
    if (data.user_id === context.userId)
      throw new Error("Você não pode excluir a si mesmo");
    // limpeza em cascata manual; as FKs de atestados e audit_logs para app_users
    // (20260818090000) cuidam do restante via cascade e set null
    await query("DELETE FROM public.user_roles WHERE user_id = $1", [
      data.user_id,
    ]);
    await query("DELETE FROM public.rh_permissions WHERE user_id = $1", [
      data.user_id,
    ]);
    await query("DELETE FROM public.profiles WHERE id = $1", [data.user_id]);
    await query("DELETE FROM public.app_users WHERE id = $1", [data.user_id]);
    return { ok: true };
  });
