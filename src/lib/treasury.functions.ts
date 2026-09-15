// O2-11 — Tesouraria (Onda 2, Lei 4.320). Contas de caixa/banco do ente e a
// movimentação financeira (ingresso, saída, transferência). O saldo da conta nunca
// fica negativo; cada movimento grava o saldo após. Reusa accounting.*.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import { applyMovement } from "./treasury.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const TenantInput = z.object({ tenant_id: z.string().uuid() });

export const getTreasuryAccounts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TenantInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");
    const accounts = await query<{
      id: string;
      nome: string;
      tipo: string;
      banco: string | null;
      agencia: string | null;
      conta: string | null;
      saldo_atual: string;
      status: string;
    }>(
      `select id, nome, tipo, banco, agencia, conta, saldo_atual::text, status
       from public.treasury_accounts where tenant_id = $1 order by nome`,
      [data.tenant_id],
    );
    return {
      accounts,
      canManage: access.permissions.includes("accounting.manage"),
    };
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  nome: z.string().trim().min(2).max(120),
  tipo: z.enum(["caixa", "banco"]),
  banco: z.string().trim().max(60).nullable().optional(),
  agencia: z.string().trim().max(20).nullable().optional(),
  conta: z.string().trim().max(30).nullable().optional(),
  status: z.enum(["ativa", "encerrada"]).default("ativa"),
});

export const saveTreasuryAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.treasury_accounts
       where tenant_id=$1 and lower(nome)=lower($2)
         and ($3::uuid is null or id<>$3)`,
      [data.tenant_id, data.nome, data.id ?? null],
    );
    if (duplicate) throw new Error("Já existe conta com este nome");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.treasury_accounts
           set nome=$3, tipo=$4, banco=$5, agencia=$6, conta=$7, status=$8,
               updated_at=now()
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.nome,
            data.tipo,
            data.banco ?? null,
            data.agencia ?? null,
            data.conta ?? null,
            data.status,
          ],
        );
      } else {
        await client.query(
          `insert into public.treasury_accounts
             (id, tenant_id, nome, tipo, banco, agencia, conta, status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            data.tenant_id,
            data.nome,
            data.tipo,
            data.banco ?? null,
            data.agencia ?? null,
            data.conta ?? null,
            data.status,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "treasury_accounts",
        recordId: id,
        after: { nome: data.nome, tipo: data.tipo },
      });
    });
    return { id };
  });

const MovementInput = z.object({
  tenant_id: z.string().uuid(),
  account_id: z.string().uuid(),
  tipo: z.enum(["ingresso", "saida"]),
  data_movimento: z.string().date(),
  valor: z.number().positive().max(1_000_000_000_000),
  historico: z.string().trim().min(3).max(500),
});

export const recordTreasuryMovement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(MovementInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.manage");
    return withTransaction(async (client) => {
      const saldo = await applyMovement(client, {
        tenantId: data.tenant_id,
        accountId: data.account_id,
        tipo: data.tipo,
        dataMovimento: data.data_movimento,
        valor: data.valor,
        historico: data.historico,
        transferRef: null,
        actorId: context.userId,
      });
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.tipo,
        resource: "treasury_movements",
        recordId: data.account_id,
        after: { valor: data.valor, saldo_apos: saldo },
      });
      return { account_id: data.account_id, saldo_atual: saldo };
    });
  });

const TransferInput = z.object({
  tenant_id: z.string().uuid(),
  origem_id: z.string().uuid(),
  destino_id: z.string().uuid(),
  data_movimento: z.string().date(),
  valor: z.number().positive().max(1_000_000_000_000),
  historico: z.string().trim().min(3).max(500),
});

// Transfere entre contas do ente: saída da origem + ingresso no destino, atômico.
export const transferBetweenAccounts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TransferInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.manage");
    if (data.origem_id === data.destino_id)
      throw new Error("Origem e destino devem ser contas diferentes");
    const transferRef = randomUUID();
    // Trava as contas em ordem estável (por id) para evitar deadlock.
    const [first, second] = [data.origem_id, data.destino_id].sort();
    return withTransaction(async (client) => {
      await client.query(
        `select id from public.treasury_accounts
         where tenant_id=$1 and id in ($2,$3) order by id for update`,
        [data.tenant_id, first, second],
      );
      const saldoOrigem = await applyMovement(client, {
        tenantId: data.tenant_id,
        accountId: data.origem_id,
        tipo: "transferencia_saida",
        dataMovimento: data.data_movimento,
        valor: data.valor,
        historico: data.historico,
        transferRef,
        actorId: context.userId,
      });
      const saldoDestino = await applyMovement(client, {
        tenantId: data.tenant_id,
        accountId: data.destino_id,
        tipo: "transferencia_entrada",
        dataMovimento: data.data_movimento,
        valor: data.valor,
        historico: data.historico,
        transferRef,
        actorId: context.userId,
      });
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "transfer",
        resource: "treasury_movements",
        recordId: transferRef,
        after: {
          origem_id: data.origem_id,
          destino_id: data.destino_id,
          valor: data.valor,
        },
      });
      return {
        transfer_ref: transferRef,
        saldo_origem: saldoOrigem,
        saldo_destino: saldoDestino,
      };
    });
  });

const LedgerInput = z.object({
  tenant_id: z.string().uuid(),
  account_id: z.string().uuid(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

// O2-11b — Extrato (razão) de uma conta de tesouraria. Lista os movimentos da conta no
// período em ordem cronológica, com o saldo após cada lançamento (persistido no ato), e
// consolida **entradas** (ingresso + transferência recebida) e **saídas** (saída +
// transferência enviada) do período — o extrato para conciliação/auditoria, isolado por
// `account_id`. Read-only, reusa accounting.read.
export const getTreasuryLedger = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(LedgerInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");
    const account = await queryOne<{ id: string }>(
      "select id from public.treasury_accounts where id=$1 and tenant_id=$2",
      [data.account_id, data.tenant_id],
    );
    if (!account) throw new Error("Conta de tesouraria não encontrada");
    const movements = await query<{
      id: string;
      tipo: string;
      data_movimento: string;
      valor: string;
      historico: string;
      saldo_apos: string;
    }>(
      `select id, tipo, data_movimento::text, valor::text, historico, saldo_apos::text
       from public.treasury_movements
       where tenant_id = $1 and account_id = $2
         and ($3::date is null or data_movimento >= $3)
         and ($4::date is null or data_movimento <= $4)
       order by data_movimento, created_at, id`,
      [data.tenant_id, data.account_id, data.from ?? null, data.to ?? null],
    );
    const entradas = movements
      .filter(
        (m) => m.tipo === "ingresso" || m.tipo === "transferencia_entrada",
      )
      .reduce((s, m) => s + Number(m.valor), 0);
    const saidas = movements
      .filter((m) => m.tipo === "saida" || m.tipo === "transferencia_saida")
      .reduce((s, m) => s + Number(m.valor), 0);
    return {
      movements,
      entradas: Number(entradas.toFixed(2)),
      saidas: Number(saidas.toFixed(2)),
    };
  });
