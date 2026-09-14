// O2-16 — Ordem bancária (OB, Onda 2). Documento que autoriza e executa o pagamento
// de um empenho liquidado (Lei 4.320 — só o liquidado paga) por uma conta de
// tesouraria: numera a OB por ente/exercício, gera a saída bancária (o saldo nunca
// fica negativo), transiciona o empenho para 'pago' e contabiliza o pagamento, tudo
// na mesma transação. Reusa accounting.* (alçada da tesouraria).
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import { contabilizarEvento, postEntry } from "./accounting.server";
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
  .validator((data: unknown) => parseInput(GetInput, data))
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
  .validator((data: unknown) => parseInput(EmitInput, data))
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
      // Se o empenho estava inscrito em restos a pagar, a OB BAIXA o resto na
      // mesma transação. Sem isto o mesmo empenho ficava "a pagar" nos restos
      // depois de pago pela OB — e um pagamento posterior do resto contava o
      // dispêndio duas vezes contra uma única saída de caixa.
      await client.query(
        `update public.restos_a_pagar
         set status='pago', pago_em=$3::date, updated_at=now()
         where commitment_id=$1 and tenant_id=$2 and status='inscrito'`,
        [data.commitment_id, data.tenant_id, data.data_emissao],
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

const CancelInput = z.object({
  tenant_id: z.string().uuid(),
  order_id: z.string().uuid(),
  data_estorno: z.string().date(),
  motivo: z.string().trim().max(500).optional(),
});

// Cancela (estorna) uma OB paga: devolve o valor à conta de tesouraria (ingresso),
// devolve o empenho ao estágio 'liquidado' e estorna a contabilização do pagamento
// (lançamento inverso ao roteiro 'pagamento', se configurado). Só uma OB 'paga'
// cancela; a de OB já cancelada é recusada. Fecha o ciclo reversível do pagamento.
export const cancelBankOrder = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(CancelInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.manage");
    return withTransaction(async (client) => {
      // OB a estornar: trava a linha; só a 'paga' cancela.
      const order = (
        await client.query<{
          exercicio: number;
          numero: string;
          commitment_id: string;
          account_id: string;
          valor: string;
          status: string;
        }>(
          `select exercicio, numero::text, commitment_id, account_id, valor::text, status
           from public.bank_orders where id = $1 and tenant_id = $2 for update`,
          [data.order_id, data.tenant_id],
        )
      ).rows[0];
      if (!order) throw new Error("Ordem bancária não encontrada");
      if (order.status !== "paga")
        throw new Error("Só uma ordem bancária paga pode ser cancelada");
      const valor = Number(order.valor);

      // Devolve o empenho ao estágio 'liquidado' (o pagamento é desfeito).
      const commitment = (
        await client.query<{ status: string }>(
          `select status from public.budget_commitments
           where id = $1 and tenant_id = $2 for update`,
          [order.commitment_id, data.tenant_id],
        )
      ).rows[0];
      if (!commitment) throw new Error("Empenho da OB não encontrado");
      // O estorno só desfaz um pagamento que existe: o estado era lido e
      // ignorado, e a OB devolvia a 'liquidado' um empenho anulado.
      if (commitment.status !== "pago")
        throw new Error(
          `A OB só estorna empenho pago (o empenho está ${commitment.status})`,
        );
      await client.query(
        `update public.budget_commitments
         set status = 'liquidado', pago_em = null, pago_por = null
         where id = $1 and tenant_id = $2`,
        [order.commitment_id, data.tenant_id],
      );
      // Reabre o resto a pagar baixado pela OB (espelho da emissão).
      await client.query(
        `update public.restos_a_pagar
         set status='inscrito', pago_em=null, updated_at=now()
         where commitment_id=$1 and tenant_id=$2 and status='pago'`,
        [order.commitment_id, data.tenant_id],
      );

      // Ingresso de estorno na conta: devolve o valor (trava a conta).
      const account = (
        await client.query<{ saldo_atual: string; status: string }>(
          `select saldo_atual::text, status from public.treasury_accounts
           where id = $1 and tenant_id = $2 for update`,
          [order.account_id, data.tenant_id],
        )
      ).rows[0];
      if (!account) throw new Error("Conta não encontrada");
      if (account.status !== "ativa")
        throw new Error("Conta encerrada não recebe estorno");
      const novoSaldo = Number(
        (Number(account.saldo_atual) + valor).toFixed(2),
      );
      await client.query(
        `insert into public.treasury_movements
           (id, tenant_id, account_id, tipo, data_movimento, valor, historico,
            saldo_apos, transfer_ref, created_by)
         values ($1,$2,$3,'ingresso',$4,$5,$6,$7,null,$8)`,
        [
          randomUUID(),
          data.tenant_id,
          order.account_id,
          data.data_estorno,
          valor,
          `Estorno da OB nº ${order.numero}`,
          novoSaldo,
          context.userId,
        ],
      );
      await client.query(
        `update public.treasury_accounts set saldo_atual = $3, updated_at = now()
         where id = $1 and tenant_id = $2`,
        [order.account_id, data.tenant_id, novoSaldo],
      );

      // Estorno contábil: lançamento inverso ao roteiro 'pagamento' (se configurado).
      const mapping = (
        await client.query<{ debit_account: string; credit_account: string }>(
          `select debit_account, credit_account
           from public.accounting_event_accounts
           where tenant_id = $1 and event_code = 'pagamento'`,
          [data.tenant_id],
        )
      ).rows[0];
      if (mapping)
        await postEntry({
          client,
          tenantId: data.tenant_id,
          exercicio: order.exercicio,
          dataLancamento: data.data_estorno,
          historico: `Estorno de pagamento — OB nº ${order.numero}`,
          // Inverte débito/crédito do pagamento original.
          lines: [
            { conta: mapping.credit_account, lado: "D", valor },
            { conta: mapping.debit_account, lado: "C", valor },
          ],
          source: "evento:pagamento_estorno",
          sourceRef: order.commitment_id,
          actorId: context.userId,
        });

      await client.query(
        `update public.bank_orders set status = 'cancelada' where id = $1 and tenant_id = $2`,
        [data.order_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "cancelar",
        resource: "bank_orders",
        recordId: data.order_id,
        after: { valor, saldo_apos: novoSaldo, motivo: data.motivo ?? null },
      });
      return { id: data.order_id, status: "cancelada", saldo_apos: novoSaldo };
    });
  });
