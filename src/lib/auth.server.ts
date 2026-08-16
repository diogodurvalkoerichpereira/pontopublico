// Autenticação própria (substitui Supabase Auth/GoTrue). SOMENTE servidor.
// Hash de senha via scrypt (node:crypto) e sessão via JWT HS256 assinado localmente.
import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from "node:crypto";

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expected] = parts;
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  const a = Buffer.from(derived, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET ausente ou menor que 32 caracteres");
  }
  return s;
}

export interface SessionClaims {
  sub: string;
  email: string;
  sid: string;
  iat: number;
  exp: number;
}

const TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24 horas, com registro revogável no banco

export function signToken(sub: string, email: string, sid: string): string {
  const secret = getSecret();
  const iat = Math.floor(Date.now() / 1000);
  const payload: SessionClaims = {
    sub,
    email,
    sid,
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = b64url(
    createHmac("sha256", secret).update(signingInput).digest(),
  );
  return `${signingInput}.${sig}`;
}

export function verifyToken(token: string): SessionClaims | null {
  try {
    const secret = getSecret();
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const expectedSig = b64url(
      createHmac("sha256", secret).update(`${h}.${p}`).digest(),
    );
    const a = Buffer.from(s);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(
      Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    ) as SessionClaims;
    if (
      !payload.sub ||
      !payload.email ||
      !payload.sid ||
      payload.exp < Math.floor(Date.now() / 1000)
    )
      return null;
    return payload;
  } catch {
    return null;
  }
}

export const TOKEN_TTL = TOKEN_TTL_SECONDS;

export function passwordPolicyIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 12) issues.push("mínimo de 12 caracteres");
  if (password.length > 72) issues.push("máximo de 72 caracteres");
  if (!/[a-z]/.test(password)) issues.push("uma letra minúscula");
  if (!/[A-Z]/.test(password)) issues.push("uma letra maiúscula");
  if (!/[0-9]/.test(password)) issues.push("um número");
  if (!/[^A-Za-z0-9]/.test(password)) issues.push("um símbolo");
  return issues;
}

export function assertStrongPassword(password: string): void {
  const issues = passwordPolicyIssues(password);
  if (issues.length) throw new Error(`Senha deve conter ${issues.join(", ")}`);
}
