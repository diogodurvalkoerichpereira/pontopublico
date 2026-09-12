// O2-11 — Tesouraria (Onda 2, Lei 4.320). Contas de caixa/banco do ente e a
// movimentação financeira (ingresso, saída, transferência). O saldo da conta nunca
// fica negativo; cada movimento grava o saldo após. Reusa accounting.*.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const TenantInput = z.object({ tenant_id: z.string().uuid() });

export const getTreasuryAccounts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
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
  .validator((data: unknown) => SaveInput.parse(data))
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

// Aplica um ingresso/saída na conta (travada FOR UPDATE); a saída nunca deixa o
// saldo negativo. Devolve o novo saldo.
async function applyMovement(
  client: {
    query: <T>(t: string, p?: unknown[]) => Promise<{ rows: T[] }>;
  },
  params: {
    tenantId: string;
    accountId: string;
    tipo:
      "ingresso" | "saida" | "transferencia_entrada" | "transferencia_saida";
    dataMovimento: string;
    valor: number;
    historico: string;
    transferRef: string | null;
    actorId: string;
  },
): Promise<number> {
  const account = (
    await client.query<{ saldo_atual: string; status: string }>(
      `select saldo_atual::text, status from public.treasury_accounts
       where id=$1 and tenant_id=$2 for update`,
      [params.accountId, params.tenantId],
    )
  ).rows[0];
  if (!account) throw new Error("Conta não encontrada");
  if (account.status !== "ativa")
    throw new Error("Conta encerrada não movimenta");
  const saida =
    params.tipo === "saida" || params.tipo === "transferencia_saida";
  const saldoAtual = Number(account.saldo_atual);
  if (saida && params.valor > saldoAtual)
    throw new Error(
      `Saída (${params.valor.toFixed(2)}) deixaria o saldo negativo (atual ${saldoAtual.toFixed(2)})`,
    );
  const novoSaldo = Number(
    (saida ? saldoAtual - params.valor : saldoAtual + params.valor).toFixed(2),
  );
  await client.query(
    `insert into public.treasury_movements
       (id, tenant_id, account_id, tipo, data_movimento, valor, historico,
        saldo_apos, transfer_ref, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      params.tenantId,
      params.accountId,
      params.tipo,
      params.dataMovimento,
      params.valor,
      params.historico,
      novoSaldo,
      params.transferRef,
      params.actorId,
    ],
  );
  await client.query(
    `update public.treasury_accounts set saldo_atual=$3, updated_at=now()
     where id=$1 and tenant_id=$2`,
    [params.accountId, params.tenantId, novoSaldo],
  );
  return novoSaldo;
}

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
  .validator((data: unknown) => MovementInput.parse(data))
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
  .validator((data: unknown) => TransferInput.parse(data))
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
