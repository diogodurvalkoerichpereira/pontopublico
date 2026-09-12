// O2-15 — Conciliação bancária (Onda 2). Compara o saldo contábil (livro) de uma
// conta de tesouraria com o saldo do extrato bancário numa data, registrando a
// diferença (extrato − livro). Uma conciliação por conta/data. Reusa accounting.*.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  account_id: z.string().uuid().optional(),
});

export const getTreasuryReconciliations = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");
    const reconciliations = await query<{
      id: string;
      account_id: string;
      data_referencia: string;
      saldo_livro: string;
      saldo_extrato: string;
      diferenca: string;
      observacao: string | null;
    }>(
      `select id, account_id, data_referencia::text, saldo_livro::text,
         saldo_extrato::text, diferenca::text, observacao
       from public.treasury_reconciliations
       where tenant_id = $1 and ($2::uuid is null or account_id = $2)
       order by data_referencia desc`,
      [data.tenant_id, data.account_id ?? null],
    );
    return {
      reconciliations,
      canManage: access.permissions.includes("accounting.manage"),
    };
  });

const ReconcileInput = z.object({
  tenant_id: z.string().uuid(),
  account_id: z.string().uuid(),
  data_referencia: z.string().date(),
  saldo_extrato: z.number().min(-1_000_000_000_000).max(1_000_000_000_000),
  observacao: z.string().trim().max(1000).nullable().optional(),
});

// Concilia a conta: diferença = saldo do extrato − saldo do livro (positiva quando
// o extrato tem mais que o livro). Uma conciliação por conta/data.
export const reconcileTreasuryAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ReconcileInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.manage");
    return withTransaction(async (client) => {
      const account = (
        await client.query<{ saldo_atual: string }>(
          `select saldo_atual::text from public.treasury_accounts
           where id=$1 and tenant_id=$2 for update`,
          [data.account_id, data.tenant_id],
        )
      ).rows[0];
      if (!account) throw new Error("Conta não encontrada");
      const dup = await client.query(
        `select id from public.treasury_reconciliations
         where tenant_id=$1 and account_id=$2 and data_referencia=$3`,
        [data.tenant_id, data.account_id, data.data_referencia],
      );
      if (dup.rows.length)
        throw new Error("Já existe conciliação desta conta nesta data");
      const saldoLivro = Number(account.saldo_atual);
      const diferenca = Number((data.saldo_extrato - saldoLivro).toFixed(2));
      const id = randomUUID();
      await client.query(
        `insert into public.treasury_reconciliations
           (id, tenant_id, account_id, data_referencia, saldo_livro,
            saldo_extrato, diferenca, observacao, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          data.account_id,
          data.data_referencia,
          saldoLivro,
          data.saldo_extrato,
          diferenca,
          data.observacao ?? null,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "conciliar",
        resource: "treasury_reconciliations",
        recordId: id,
        after: {
          saldo_livro: saldoLivro,
          saldo_extrato: data.saldo_extrato,
          diferenca,
        },
      });
      return { id, saldo_livro: saldoLivro, diferenca };
    });
  });
