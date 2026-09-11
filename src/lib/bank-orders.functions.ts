// O2-16 — Ordem bancária (OB, Onda 2). Documento que autoriza e executa o pagamento
// de um empenho liquidado (Lei 4.320 — só o liquidado paga) por uma conta de
// tesouraria: numera a OB por ente/exercício, gera a saída bancária (o saldo nunca
// fica negativo), transiciona o empenho para 'pago' e contabiliza o pagamento, tudo
// na mesma transação. Reusa accounting.* (alçada da tesouraria).
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import { contabilizarEvento } from "./accounting.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2100).optional(),
});

export const getBankOrders = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");
    const orders = await query<{
      id: string;
      exercicio: number;
      numero: string;
      commitment_id: string;
      account_id: string;
      credor: string;
      valor: string;
      data_emissao: string;
      status: string;
    }>(
      `select id, exercicio, numero::text, commitment_id, account_id, credor,
         valor::text, data_emissao::text, status
       from public.bank_orders
       where tenant_id = $1 and ($2::int is null or exercicio = $2)
       order by exercicio desc, numero desc`,
      [data.tenant_id, data.exercicio ?? null],
    );
    return {
      orders,
      canManage: access.permissions.includes("accounting.manage"),
    };
  });

const EmitInput = z.object({
  tenant_id: z.string().uuid(),
  commitment_id: z.string().uuid(),
  account_id: z.string().uuid(),
  data_emissao: z.string().date(),
  historico: z.string().trim().max(500).optional(),
});

// Emite a ordem bancária que paga o empenho liquidado pela conta indicada. Um empenho
// só paga uma vez (unique tenant/commitment no banco + guarda de estado 'liquidado').
export const emitBankOrder = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => EmitInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.manage");
    return withTransaction(async (client) => {
      // Empenho a pagar: trava a linha e exige o estágio 'liquidado' (Lei 4.320).
      const commitment = (
        await client.query<{
          status: string;
          exercicio: number;
          valor: string;
          credor: string;
        }>(
          `select status, exercicio, valor::text, credor
           from public.budget_commitments
           where id = $1 and tenant_id = $2 for update`,
          [data.commitment_id, data.tenant_id],
        )
      ).rows[0];
      if (!commitment) throw new Error("Empenho não encontrado");
      if (commitment.status !== "liquidado")
        throw new Error(
          "Só um empenho liquidado pode ser pago por ordem bancária",
        );
      const valor = Number(commitment.valor);

      // Conta de tesouraria: trava a linha; a saída nunca deixa o saldo negativo.
      const account = (
        await client.query<{ saldo_atual: string; status: string }>(
          `select saldo_atual::text, status from public.treasury_accounts
           where id = $1 and tenant_id = $2 for update`,
          [data.account_id, data.tenant_id],
        )
      ).rows[0];
      if (!account) throw new Error("Conta não encontrada");
      if (account.status !== "ativa")
        throw new Error("Conta encerrada não paga ordem bancária");
      const saldoAtual = Number(account.saldo_atual);
      if (valor > saldoAtual)
        throw new Error(
          `Pagamento (${valor.toFixed(2)}) deixaria o saldo negativo (atual ${saldoAtual.toFixed(2)})`,
        );

      // Numeração sequencial por ente/exercício (linha-contador travada).
      await client.query(
        `insert into public.bank_order_counters (tenant_id, exercicio)
         values ($1, $2) on conflict do nothing`,
        [data.tenant_id, commitment.exercicio],
      );
      const counter = (
        await client.query<{ last_numero: string }>(
          `select last_numero::text from public.bank_order_counters
           where tenant_id = $1 and exercicio = $2 for update`,
          [data.tenant_id, commitment.exercicio],
        )
      ).rows[0];
      const numero = Number(counter.last_numero) + 1;
      await client.query(
        `update public.bank_order_counters set last_numero = $3
         where tenant_id = $1 and exercicio = $2`,
        [data.tenant_id, commitment.exercicio, numero],
      );

      // Saída bancária: registra o movimento e baixa o saldo da conta.
      const novoSaldo = Number((saldoAtual - valor).toFixed(2));
      const movementId = randomUUID();
      const historico =
        data.historico ?? `OB nº ${numero} — ${commitment.credor}`;
      await client.query(
        `insert into public.treasury_movements
           (id, tenant_id, account_id, tipo, data_movimento, valor, historico,
            saldo_apos, transfer_ref, created_by)
         values ($1,$2,$3,'saida',$4,$5,$6,$7,null,$8)`,
        [
          movementId,
          data.tenant_id,
          data.account_id,
          data.data_emissao,
          valor,
          historico,
          novoSaldo,
          context.userId,
        ],
      );
      await client.query(
        `update public.treasury_accounts set saldo_atual = $3, updated_at = now()
         where id = $1 and tenant_id = $2`,
        [data.account_id, data.tenant_id, novoSaldo],
      );

      // Empenho vai a 'pago' e o fato contabiliza (evento 'pagamento').
      await client.query(
        `update public.budget_commitments
         set status = 'pago', pago_em = now(), pago_por = $3
         where id = $1 and tenant_id = $2`,
        [data.commitment_id, data.tenant_id, context.userId],
      );
      await contabilizarEvento({
        client,
        tenantId: data.tenant_id,
        exercicio: commitment.exercicio,
        dataLancamento: data.data_emissao,
        eventCode: "pagamento",
        valor,
        historico: `Pagamento por OB nº ${numero}`,
        sourceRef: data.commitment_id,
        actorId: context.userId,
      });

      const id = randomUUID();
      await client.query(
        `insert into public.bank_orders
           (id, tenant_id, exercicio, numero, commitment_id, account_id,
            movement_id, credor, valor, data_emissao, historico, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          data.tenant_id,
          commitment.exercicio,
          numero,
          data.commitment_id,
          data.account_id,
          movementId,
          commitment.credor,
          valor,
          data.data_emissao,
          data.historico ?? null,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "emitir",
        resource: "bank_orders",
        recordId: id,
        after: { numero, valor, saldo_apos: novoSaldo },
      });
      return { id, numero, valor, saldo_apos: novoSaldo };
    });
  });
