// Segundo fator (TOTP RFC 6238) e cifra em repouso do segredo. SOMENTE servidor.
//
// TOTP compativel com Google Authenticator/Aegis/1Password (base32, HMAC-SHA1,
// passo de 30s, janela +/-1). O segredo do usuario e cifrado com AES-256-GCM sob
// a chave dedicada MFA_ENC_KEY (32 bytes, fora do banco) e so decifrado no
// momento de verificar um codigo. Codigos de recuperacao sao guardados como hash
// scrypt (mesmo formato de auth.server.ts) e consumidos ao usar.
import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Base32 (RFC 4648, alfabeto padrao, sem padding) — formato dos apps de TOTP.
// ---------------------------------------------------------------------------
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[=\s]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Segredo TOTP invalido");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// HOTP/TOTP (RFC 4226 / RFC 6238).
// ---------------------------------------------------------------------------
const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // aceita o passo anterior e o proximo (relogio dessincronizado)

function hotp(key: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  // counter big-endian de 64 bits (o topo cabe em 32 bits para qualquer data util).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/** Codigo TOTP para um dado instante. Parametrizavel para os vetores de teste. */
export function totpCode(
  secretBase32: string,
  opts: { time?: number; step?: number; digits?: number } = {},
): string {
  const time = opts.time ?? Math.floor(Date.now() / 1000);
  const step = opts.step ?? STEP_SECONDS;
  const digits = opts.digits ?? DIGITS;
  const counter = Math.floor(time / step);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/** Verifica um codigo de 6 digitos aceitando a janela +/-1, em tempo constante. */
export function verifyTotp(
  secretBase32: string,
  code: string,
  atTime?: number,
): boolean {
  const clean = (code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const time = atTime ?? Math.floor(Date.now() / 1000);
  const key = base32Decode(secretBase32);
  const baseCounter = Math.floor(time / STEP_SECONDS);
  const candidate = Buffer.from(clean);
  let ok = false;
  for (let w = -WINDOW; w <= WINDOW; w++) {
    const expected = Buffer.from(hotp(key, baseCounter + w, DIGITS));
    // Sem short-circuit: sempre percorre a janela inteira (nao vaza timing).
    if (
      expected.length === candidate.length &&
      timingSafeEqual(expected, candidate)
    )
      ok = true;
  }
  return ok;
}

/** Segredo novo (160 bits) em base32, pronto para o app autenticador. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** URI otpauth:// para o QR code. issuer/label seguem o padrao dos apps. */
export function otpauthUri(secretBase32: string, email: string): string {
  const issuer = "PontoPublico";
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Cifra em repouso do segredo — AES-256-GCM sob MFA_ENC_KEY.
// ---------------------------------------------------------------------------
function getMfaKey(): Buffer {
  const raw = process.env.MFA_ENC_KEY;
  if (!raw || raw.length < 32) {
    throw new Error("MFA_ENC_KEY ausente ou menor que 32 caracteres");
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  // Texto arbitrario: deriva 32 bytes de forma estavel (nao aleatoria).
  return scryptSync(raw, "pontopublico-mfa-enc", 32);
}

/** Cifra o segredo TOTP. Saida `iv:tag:dados` (hex); IV aleatorio por chamada. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMfaKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/** Decifra o segredo TOTP. Lanca se o tag nao bater (dado adulterado). */
export function decryptSecret(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("Segredo cifrado invalido");
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getMfaKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Codigos de recuperacao — mostrados uma vez, guardados como hash scrypt.
// ---------------------------------------------------------------------------
const BACKUP_CODE_COUNT = 10;
const SCRYPT_KEYLEN = 64;

function hashBackupCode(code: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(code, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function backupCodeMatches(code: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expected] = parts;
  const derived = scryptSync(code, salt, SCRYPT_KEYLEN);
  const b = Buffer.from(expected, "hex");
  if (derived.length !== b.length) return false;
  return timingSafeEqual(derived, b);
}

/** Gera N codigos legiveis (formato XXXX-XXXX) e seus hashes para persistir. */
export function generateBackupCodes(): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const raw = base32Encode(randomBytes(5)).slice(0, 8);
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    codes.push(code);
    hashes.push(hashBackupCode(code));
  }
  return { codes, hashes };
}

/**
 * Consome um codigo de recuperacao: se `code` casa com algum hash, devolve
 * { matched: true, remaining } sem o hash usado. Normaliza hifen e caixa.
 */
export function consumeBackupCode(
  code: string,
  hashes: string[],
): { matched: boolean; remaining: string[] } {
  const normalized = (code || "").replace(/\s/g, "").toUpperCase();
  const withDash =
    normalized.includes("-") || normalized.length !== 8
      ? normalized
      : `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
  let matchedIndex = -1;
  hashes.forEach((h, i) => {
    if (backupCodeMatches(withDash, h)) matchedIndex = i;
  });
  if (matchedIndex === -1) return { matched: false, remaining: hashes };
  return {
    matched: true,
    remaining: hashes.filter((_, i) => i !== matchedIndex),
  };
}
