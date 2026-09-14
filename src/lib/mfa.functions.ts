// Server functions do segundo fator (O0-09). MFA é sobre o próprio usuário, sem
// contexto de tenant — todas exigem apenas `requireAuth` (identidade). Entram na
// ALLOWLIST do teste de cobertura de autorização por essa razão.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  generateSecret,
  encryptSecret,
  decryptSecret,
  verifyTotp,
  otpauthUri,
  generateBackupCodes,
  consumeBackupCode,
} from "./mfa.server";

interface FactorRow {
  secret_enc: string;
  confirmed_at: string | null;
  backup_codes_hash: string[];
}

async function loadFactor(userId: string): Promise<FactorRow | null> {
  return queryOne<FactorRow>(
    `select secret_enc, confirmed_at::text, backup_codes_hash
     from private.auth_mfa_factors where user_id=$1`,
    [userId],
  );
}

// { enrolled: fator confirmado; sessionMfaBacked: sessão atual já verificou }.
export const getMfaStatus = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const factor = await loadFactor(context.userId);
    return {
      enrolled: Boolean(factor?.confirmed_at),
      sessionMfaBacked: Boolean(context.mfaVerifiedAt),
    };
  });

// Gera um segredo novo e o grava NÃO confirmado (cifrado). Devolve o segredo e a
// URI otpauth para o app autenticador. Bloqueia se já houver fator confirmado.
export const startMfaEnrollment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const existing = await loadFactor(context.userId);
    if (existing?.confirmed_at)
      throw new Error("MFA já configurado; desative antes de gerar um novo");
    const secret = generateSecret();
    const secretEnc = encryptSecret(secret);
    await query(
      `insert into private.auth_mfa_factors (user_id, secret_enc)
       values ($1,$2)
       on conflict (user_id) do update
         set secret_enc=excluded.secret_enc,
             confirmed_at=null,
             backup_codes_hash='{}',
             updated_at=now()`,
      [context.userId, secretEnc],
    );
    return { secret, otpauthUri: otpauthUri(secret, context.email) };
  });

const CodeInput = z.object({ code: z.string().min(1).max(20) });

// Confirma a inscrição validando um código contra o segredo pendente. Marca
// confirmed_at e devolve os códigos de recuperação UMA ÚNICA VEZ.
export const confirmMfaEnrollment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => parseInput(CodeInput, v))
  .handler(async ({ data, context }) => {
    const factor = await loadFactor(context.userId);
    if (!factor) throw new Error("Nenhuma inscrição de MFA pendente");
    if (factor.confirmed_at) throw new Error("MFA já confirmado");
    const secret = decryptSecret(factor.secret_enc);
    if (!verifyTotp(secret, data.code)) throw new Error("Código inválido");
    const { codes, hashes } = generateBackupCodes();
    await query(
      `update private.auth_mfa_factors
         set confirmed_at=now(), backup_codes_hash=$2, updated_at=now()
       where user_id=$1`,
      [context.userId, hashes],
    );
    return { backupCodes: codes };
  });

// Verifica o segundo fator (TOTP ou código de recuperação) e carimba a sessão
// atual como MFA-backed. Códigos de recuperação são consumidos ao usar.
export const verifyMfa = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => parseInput(CodeInput, v))
  .handler(async ({ data, context }) => {
    const factor = await loadFactor(context.userId);
    if (!factor?.confirmed_at) throw new Error("MFA não configurado");
    const secret = decryptSecret(factor.secret_enc);
    await withTransaction(async (c) => {
      if (verifyTotp(secret, data.code)) {
        await c.query(
          `update private.auth_sessions set mfa_verified_at=now() where id=$1`,
          [context.sessionId],
        );
        return;
      }
      const consumed = consumeBackupCode(data.code, factor.backup_codes_hash);
      if (!consumed.matched) throw new Error("Código inválido");
      await c.query(
        `update private.auth_mfa_factors
           set backup_codes_hash=$2, updated_at=now() where user_id=$1`,
        [context.userId, consumed.remaining],
      );
      await c.query(
        `update private.auth_sessions set mfa_verified_at=now() where id=$1`,
        [context.sessionId],
      );
    });
    return { ok: true };
  });

// Remove o fator após validar um código. Limpa o carimbo de MFA das sessões do
// usuário — sem fator, nenhuma sessão segue MFA-backed.
export const disableMfa = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => parseInput(CodeInput, v))
  .handler(async ({ data, context }) => {
    const factor = await loadFactor(context.userId);
    if (!factor?.confirmed_at) throw new Error("MFA não configurado");
    const secret = decryptSecret(factor.secret_enc);
    const valid =
      verifyTotp(secret, data.code) ||
      consumeBackupCode(data.code, factor.backup_codes_hash).matched;
    if (!valid) throw new Error("Código inválido");
    await withTransaction(async (c) => {
      await c.query(`delete from private.auth_mfa_factors where user_id=$1`, [
        context.userId,
      ]);
      await c.query(
        `update private.auth_sessions set mfa_verified_at=null where user_id=$1`,
        [context.userId],
      );
    });
    return { ok: true };
  });
