// Encadeamento das marcacoes de ponto (O1-03a) — SOMENTE servidor.
// Fonte unica do hash de cada marcacao: uma string canonica de campos em ordem
// fixa (nunca a ordem de chaves de um objeto JS), no molde de
// stableFiscalBracketsJson (payroll-formula.server.ts). Usada ao gravar E ao
// verificar a cadeia, para conferirem byte a byte.
import { createHash } from "node:crypto";

/** previous_hash da primeira marcacao de cada ente (genesis). */
export const GENESIS_HASH = "0".repeat(64);

export interface PunchHashInput {
  tenantId: string;
  employmentLinkId: string;
  nsr: number;
  punchTime: string; // ISO 8601 (UTC)
  source: string;
  previousHash: string;
}

/** Serializacao canonica dos campos encadeados — ordem fixa, sem depender de JS. */
export function stablePunchString(input: PunchHashInput): string {
  return [
    input.tenantId,
    input.employmentLinkId,
    String(input.nsr),
    input.punchTime,
    input.source,
    input.previousHash,
  ].join("|");
}

export function hashPunch(input: PunchHashInput): string {
  return createHash("sha256")
    .update(stablePunchString(input), "utf8")
    .digest("hex");
}
