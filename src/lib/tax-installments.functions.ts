// O4-02 — Parcelamento de crédito tributário em dívida ativa (Onda 4). Um crédito
// em dívida ativa, com saldo devedor, é parcelado: o saldo é rateado em N parcelas
// mensais (a última absorve o arredondamento, para somar o saldo exato). Cada
// parcela paga arrecada no crédito; quando todas quitam, o crédito quita. Reusa as
// permissões de tributos (taxes.*).
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
  credit_id: z.string().uuid().optional(),
});

export const getInstallmentPlans = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const plans = await query<{
      id: string;
      credit_id: string;
      numero_parcelas: number;
      valor_total: string;
      data_acordo: string;
      status: string;
      parcelas_pagas: string;
    }>(
      `select p.id, p.credit_id, p.numero_parcelas, p.valor_total::text,
         p.data_acordo::text, p.status,
         (select count(*) from public.tax_installments i
          where i.plan_id = p.id and i.status = 'paga')::text as parcelas_pagas
       from public.tax_installment_plans p
       where p.tenant_id = $1 and ($2::uuid is null or p.credit_id = $2)
       order by p.data_acordo desc`,
      [data.tenant_id, data.credit_id ?? null],
    );
    return {
      plans,
      canManage: access.permissions.includes("taxes.manage"),
    };
  });

const GetInstallmentsInput = z.object({
  tenant_id: z.string().uuid(),
  plan_id: z.string().uuid(),
});

// Lista as parcelas de um plano (número, valor, vencimento, situação).
export const getInstallments = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInstallmentsInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    return query<{
      id: string;
      numero: number;
      valor: string;
      vencimento: string;
      status: string;
      paga_em: string | null;
    }>(
      `select id, numero, valor::text, vencimento::text, status, paga_em::text
       from public.tax_installments
       where tenant_id = $1 and plan_id = $2
       order by numero`,
      [data.tenant_id, data.plan_id],
    );
  });

const CreateInput = z.object({
  tenant_id: z.string().uuid(),
  credit_id: z.string().uuid(),
  numero_parcelas: z.number().int().min(1).max(240),
  data_acordo: z.string().date(),
  primeiro_vencimento: z.string().date(),
});

// Soma um mês à data (UTC), fixando o dia de vencimento — clampa em fim de mês.
function addMonths(iso: string, months: number): string {
  const base = new Date(`${iso}T00:00:00Z`);
  const dia = base.getUTCDate();
  const d = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1),
  );
  const ultimoDia = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimoDia));
  return d.toISOString().slice(0, 10);
}

// Abre um parcelamento do saldo devedor de um crédito em dívida ativa.
export const createInstallmentPlan = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CreateInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const credit = (
        await client.query<{
          valor_lancado: string;
          valor_pago: string;
          status: string;
        }>(
          `select valor_lancado::text, valor_pago::text, status
           from public.tax_credits where id=$1 and tenant_id=$2 for update`,
          [data.credit_id, data.tenant_id],
        )
      ).rows[0];
      if (!credit) throw new Error("Crédito tributário não encontrado");
      if (credit.status !== "divida_ativa")
        throw new Error("Só um crédito em dívida ativa pode ser parcelado");
      const saldo = Number(
        (Number(credit.valor_lancado) - Number(credit.valor_pago)).toFixed(2),
      );
      if (saldo <= 0) throw new Error("Crédito sem saldo devedor a parcelar");
      const ativo = (
        await client.query<{ id: string }>(
          `select id from public.tax_installment_plans
           where credit_id=$1 and status='ativo'`,
          [data.credit_id],
        )
      ).rows[0];
      if (ativo) throw new Error("Crédito já possui parcelamento ativo");

      const n = data.numero_parcelas;
      const parcelaBase = Math.floor((saldo / n) * 100) / 100;
      const planId = randomUUID();
      await client.query(
        `insert into public.tax_installment_plans
           (id, tenant_id, credit_id, numero_parcelas, valor_total, data_acordo,
            created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          planId,
          data.tenant_id,
          data.credit_id,
          n,
          saldo,
          data.data_acordo,
          context.userId,
        ],
      );
      let somaAnteriores = 0;
      for (let i = 1; i <= n; i++) {
        // A última parcela absorve o arredondamento (soma exata do saldo).
        const valor =
          i < n ? parcelaBase : Number((saldo - somaAnteriores).toFixed(2));
        somaAnteriores = Number((somaAnteriores + valor).toFixed(2));
        await client.query(
          `insert into public.tax_installments
             (id, tenant_id, plan_id, numero, valor, vencimento)
           values ($1,$2,$3,$4,$5,$6)`,
          [
            randomUUID(),
            data.tenant_id,
            planId,
            i,
            valor,
            addMonths(data.primeiro_vencimento, i - 1),
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "parcelar",
        resource: "tax_installment_plans",
        recordId: planId,
        after: { credit_id: data.credit_id, numero_parcelas: n, saldo },
      });
      return {
        plan_id: planId,
        numero_parcelas: n,
        valor_parcela: parcelaBase,
        saldo,
      };
    });
  });

const PayInput = z.object({
  tenant_id: z.string().uuid(),
  installment_id: z.string().uuid(),
  data_pagamento: z.string().date(),
});

// Paga uma parcela: arrecada o valor no crédito; a última quita crédito e plano.
export const payInstallment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => PayInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const parcela = (
        await client.query<{
          plan_id: string;
          valor: string;
          status: string;
        }>(
          `select plan_id, valor::text, status from public.tax_installments
           where id=$1 and tenant_id=$2 for update`,
          [data.installment_id, data.tenant_id],
        )
      ).rows[0];
      if (!parcela) throw new Error("Parcela não encontrada");
      if (parcela.status !== "aberta") throw new Error("Parcela já está paga");
      const plan = (
        await client.query<{ credit_id: string; status: string }>(
          `select credit_id, status from public.tax_installment_plans
           where id=$1 and tenant_id=$2 for update`,
          [parcela.plan_id, data.tenant_id],
        )
      ).rows[0];
      if (!plan || plan.status !== "ativo")
        throw new Error("Parcelamento não está ativo");
      const credit = (
        await client.query<{ valor_lancado: string; valor_pago: string }>(
          `select valor_lancado::text, valor_pago::text
           from public.tax_credits where id=$1 and tenant_id=$2 for update`,
          [plan.credit_id, data.tenant_id],
        )
      ).rows[0];
      if (!credit) throw new Error("Crédito tributário não encontrado");

      await client.query(
        `update public.tax_installments
         set status='paga', paga_em=$3::date where id=$1 and tenant_id=$2`,
        [data.installment_id, data.tenant_id, data.data_pagamento],
      );
      // Registra a arrecadação da parcela no crédito. O4-14c — a origem vem da
      // situação do crédito NESTE momento (antes de eventualmente quitar): parcela
      // de crédito inscrito é receita de dívida ativa.
      await client.query(
        `insert into public.tax_payments
           (id, tenant_id, credit_id, data_pagamento, valor, created_by, origem)
         values ($1,$2,$3,$4,$5,$6,
           (select case when status='divida_ativa' then 'divida_ativa' else 'corrente' end
            from public.tax_credits where id=$3 and tenant_id=$2))`,
        [
          randomUUID(),
          data.tenant_id,
          plan.credit_id,
          data.data_pagamento,
          Number(parcela.valor),
          context.userId,
        ],
      );
      const novoPago = Number(
        (Number(credit.valor_pago) + Number(parcela.valor)).toFixed(2),
      );
      const abertas = Number(
        (
          await client.query<{ n: string }>(
            `select count(*)::text as n from public.tax_installments
             where plan_id=$1 and status='aberta'`,
            [parcela.plan_id],
          )
        ).rows[0].n,
      );
      const quitado = abertas === 0;
      await client.query(
        `update public.tax_credits
         set valor_pago=$3, status=case when $4 then 'quitado' else status end,
             updated_at=now()
         where id=$1 and tenant_id=$2`,
        [plan.credit_id, data.tenant_id, novoPago, quitado],
      );
      if (quitado) {
        await client.query(
          `update public.tax_installment_plans
           set status='quitado', updated_at=now() where id=$1 and tenant_id=$2`,
          [parcela.plan_id, data.tenant_id],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "pagar_parcela",
        resource: "tax_installments",
        recordId: data.installment_id,
        after: { valor: Number(parcela.valor), plano_quitado: quitado },
      });
      return { paga: true, plano_quitado: quitado };
    });
  });

const RescindInput = z.object({
  tenant_id: z.string().uuid(),
  plan_id: z.string().uuid(),
  data_referencia: z.string().date(),
  limite_atraso: z.number().int().min(1).max(24).default(3),
});

// O4-11 — Rescinde o parcelamento por inadimplência: com pelo menos `limite_atraso`
// parcelas vencidas e não pagas na data de referência, o plano é rescindido e o crédito
// permanece em dívida ativa com o saldo remanescente (as parcelas pagas já arrecadaram).
export const rescindInstallmentPlan = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => RescindInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const plan = (
        await client.query<{ status: string }>(
          `select status from public.tax_installment_plans
           where id=$1 and tenant_id=$2 for update`,
          [data.plan_id, data.tenant_id],
        )
      ).rows[0];
      if (!plan) throw new Error("Parcelamento não encontrado");
      if (plan.status !== "ativo")
        throw new Error("Só um parcelamento ativo pode ser rescindido");

      // Parcelas vencidas e ainda abertas na data de referência.
      const vencidas = Number(
        (
          await client.query<{ n: string }>(
            `select count(*)::text as n from public.tax_installments
             where plan_id=$1 and status='aberta' and vencimento < $2::date`,
            [data.plan_id, data.data_referencia],
          )
        ).rows[0].n,
      );
      if (vencidas < data.limite_atraso)
        throw new Error(
          `Inadimplência insuficiente para rescisão (${vencidas} de ${data.limite_atraso} parcelas vencidas)`,
        );

      await client.query(
        `update public.tax_installment_plans
         set status='rescindido', updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.plan_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "rescindir_parcelamento",
        resource: "tax_installment_plans",
        recordId: data.plan_id,
        after: { parcelas_vencidas: vencidas },
      });
      return {
        id: data.plan_id,
        status: "rescindido",
        parcelas_vencidas: vencidas,
      };
    });
  });

const SummaryInput = z.object({
  tenant_id: z.string().uuid(),
  data_referencia: z.string().date(),
});

// O4-02b — Carteira de parcelamentos (REFIS). Consolida os planos por situação
// (ativo/quitado/rescindido) e, nas parcelas: o **arrecadado** (parcelas pagas, de qualquer
// plano — o dinheiro já entrou), o **a receber** (parcelas abertas de planos **ainda
// ativos** — plano rescindido devolve o saldo à dívida ativa, deixa de ser recebível pela
// via do parcelamento) e o **vencido** (abertas de plano ativo com vencimento anterior à
// data de referência) — a inadimplência da carteira. Read-only, reusa taxes.read.
export const getInstallmentPlansSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SummaryInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const planos = (
      await query<{ ativos: string; quitados: string; rescindidos: string }>(
        `select
           count(*) filter (where status='ativo')::text as ativos,
           count(*) filter (where status='quitado')::text as quitados,
           count(*) filter (where status='rescindido')::text as rescindidos
         from public.tax_installment_plans
         where tenant_id = $1`,
        [data.tenant_id],
      )
    )[0];
    const parc = (
      await query<{ arrecadado: string; a_receber: string; vencido: string }>(
        `select
           coalesce(sum(i.valor) filter (where i.status='paga'),0)::text as arrecadado,
           coalesce(sum(i.valor) filter (where i.status='aberta' and p.status='ativo'),0)::text as a_receber,
           coalesce(sum(i.valor) filter (where i.status='aberta' and p.status='ativo' and i.vencimento < $2::date),0)::text as vencido
         from public.tax_installments i
         join public.tax_installment_plans p on p.id = i.plan_id
         where i.tenant_id = $1`,
        [data.tenant_id, data.data_referencia],
      )
    )[0];
    return {
      planosPorStatus: {
        ativo: Number(planos.ativos),
        quitado: Number(planos.quitados),
        rescindido: Number(planos.rescindidos),
      },
      arrecadado: Number(parc.arrecadado),
      aReceber: Number(parc.a_receber),
      vencido: Number(parc.vencido),
    };
  });
