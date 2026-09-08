/**
 * Testes de comportamento do segundo fator (O0-09).
 *
 * Como os demais testes de verdade do projeto, executa o codigo: o modulo
 * mfa.server.ts (TypeScript, so node:crypto) e empacotado com esbuild e as
 * assercoes recaem sobre a saida real — nao sobre o texto do arquivo.
 *
 * Cobre: TOTP contra os vetores oficiais da RFC 6238 (Apendice B), o
 * round-trip AES-256-GCM (incluindo deteccao de adulteracao), a janela de
 * verificacao e o consumo de codigos de recuperacao. O guard fail-closed
 * (requireCriticalMfa) e exercitado a parte, sobre tenant-access.server.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "mfa-test-"));

// MFA_ENC_KEY deterministica para o round-trip (32 bytes em hex).
process.env.MFA_ENC_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mfaBundle = join(dir, "mfa.bundle.mjs");
await build({
  entryPoints: ["src/lib/mfa.server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: mfaBundle,
  logLevel: "silent",
  external: ["node:*"],
});
const mfa = await import(mfaBundle);

// --- TOTP: vetores oficiais RFC 6238 Apendice B (modo SHA1, 8 digitos) --------
// Seed ASCII "12345678901234567890" (20 bytes), codificada em base32.
const RFC_SECRET = mfa.base32Encode(Buffer.from("12345678901234567890"));
const RFC_VECTORS = [
  { time: 59, code: "94287082" },
  { time: 1111111109, code: "07081804" },
  { time: 1111111111, code: "14050471" },
  { time: 1234567890, code: "89005924" },
  { time: 2000000000, code: "69279037" },
  { time: 20000000000, code: "65353130" },
];

test("TOTP bate com os vetores oficiais da RFC 6238 (SHA1)", () => {
  for (const v of RFC_VECTORS) {
    assert.equal(
      mfa.totpCode(RFC_SECRET, { time: v.time, digits: 8, step: 30 }),
      v.code,
      `T=${v.time}`,
    );
  }
});

test("verifyTotp aceita o codigo do passo atual e a janela +/-1", () => {
  const secret = mfa.generateSecret();
  const now = 1_700_000_000;
  const code = mfa.totpCode(secret, { time: now });
  assert.equal(mfa.verifyTotp(secret, code, now), true, "passo atual");
  assert.equal(
    mfa.verifyTotp(secret, code, now + 30),
    true,
    "passo seguinte (relogio adiantado 30s)",
  );
  assert.equal(
    mfa.verifyTotp(secret, code, now - 30),
    true,
    "passo anterior (relogio atrasado 30s)",
  );
  assert.equal(
    mfa.verifyTotp(secret, code, now + 120),
    false,
    "fora da janela deve falhar",
  );
  assert.equal(mfa.verifyTotp(secret, "000000", now), false, "codigo errado");
  assert.equal(mfa.verifyTotp(secret, "12345", now), false, "formato invalido");
});

// --- AES-256-GCM round-trip ---------------------------------------------------
test("encryptSecret/decryptSecret faz round-trip e usa IV aleatorio", () => {
  const secret = mfa.generateSecret();
  const c1 = mfa.encryptSecret(secret);
  const c2 = mfa.encryptSecret(secret);
  assert.notEqual(c1, c2, "IV aleatorio: ciphertext difere a cada chamada");
  assert.equal(mfa.decryptSecret(c1), secret);
  assert.equal(mfa.decryptSecret(c2), secret);
});

test("decryptSecret rejeita ciphertext adulterado (tag GCM)", () => {
  const c = mfa.encryptSecret("segredo");
  const [iv, tag, data] = c.split(":");
  // Vira o ultimo nibble dos dados: o tag de autenticacao nao bate mais.
  const flipped = data.slice(0, -1) + (data.slice(-1) === "0" ? "1" : "0");
  assert.throws(() => mfa.decryptSecret(`${iv}:${tag}:${flipped}`));
});

// --- Codigos de recuperacao ---------------------------------------------------
test("codigos de recuperacao: consumo remove o hash usado e nao reaproveita", () => {
  const { codes, hashes } = mfa.generateBackupCodes();
  assert.equal(codes.length, 10);
  assert.equal(hashes.length, 10);

  const first = codes[0];
  const r1 = mfa.consumeBackupCode(first, hashes);
  assert.equal(r1.matched, true, "codigo valido casa");
  assert.equal(r1.remaining.length, 9, "o hash usado sai da lista");

  const r2 = mfa.consumeBackupCode(first, r1.remaining);
  assert.equal(r2.matched, false, "codigo ja consumido nao casa de novo");

  // Aceita sem hifen e em caixa baixa (tolerancia de digitacao).
  const r3 = mfa.consumeBackupCode(
    codes[1].replace("-", "").toLowerCase(),
    hashes,
  );
  assert.equal(r3.matched, true, "normaliza hifen e caixa");
});

test("otpauthUri carrega segredo e emissor", () => {
  const secret = mfa.generateSecret();
  const uri = mfa.otpauthUri(secret, "user@example.com");
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, new RegExp(`secret=${secret}`));
  assert.match(uri, /issuer=PontoPublico/);
});

// --- Guard fail-closed requireCriticalMfa (mutação) ---------------------------
// tenant-access.server.ts importa db.server e pgrest.server; ambos viram stub
// para que o bundle traga apenas a lógica pura do guard.
const dbStub = join(dir, "db-stub.mjs");
writeFileSync(
  dbStub,
  `export async function query() { return []; }
   export async function queryOne() { return null; }
   export async function withTransaction(fn) { return fn({ query }); }`,
);
const pgrestStub = join(dir, "pgrest-stub.mjs");
writeFileSync(
  pgrestStub,
  `export async function loadAccess() { return { roles: [], perms: [] }; }`,
);

const taBundle = join(dir, "tenant-access.bundle.mjs");
await build({
  entryPoints: ["src/lib/tenant-access.server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: taBundle,
  logLevel: "silent",
  external: ["node:*"],
  plugins: [
    {
      name: "stub-deps",
      setup(b) {
        b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({
          path: dbStub,
          external: true,
        }));
        b.onResolve({ filter: /(^|\/)pgrest\.server$/ }, () => ({
          path: pgrestStub,
          external: true,
        }));
      },
    },
  ],
});
const ta = await import(taBundle);

test("requireCriticalMfa: permissão protegida sem MFA lança MFA_REQUIRED", () => {
  assert.throws(
    () => ta.requireCriticalMfa("payroll.cycles.close", null),
    /MFA_REQUIRED/,
    "fechar folha sem segundo fator deve travar",
  );
  assert.throws(
    () => ta.requireCriticalMfa("security.manage", undefined),
    /MFA_REQUIRED/,
  );
});

test("requireCriticalMfa: com sessão MFA-backed, permissão protegida passa", () => {
  assert.doesNotThrow(() =>
    ta.requireCriticalMfa("payroll.cycles.close", "2026-09-08T00:00:00Z"),
  );
});

test("requireCriticalMfa: permissão fora do conjunto passa mesmo sem MFA", () => {
  assert.doesNotThrow(() => ta.requireCriticalMfa("people.manage", null));
  assert.equal(ta.PROTECTED_MFA_PERMISSIONS.has("people.manage"), false);
  assert.equal(ta.PROTECTED_MFA_PERMISSIONS.has("payroll.cycles.reopen"), true);
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
