// O4-01 — Tributos (Onda 4). Lançamento, arrecadação e inscrição em dívida ativa.
// A arrecadação nunca excede o saldo; quitação zera o saldo. Vencido e não pago
// pode ser inscrito em dívida ativa (Lei 6.830).
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

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  status: z
    .enum(["lancado", "divida_ativa", "quitado", "cancelado"])
    .optional(),
});

const SummaryInput = z.object({ tenant_id: z.string().uuid() });

// O4-01b — Resumo da arrecadação tributária. Consolida os créditos por situação
// (lancado/divida_ativa/quitado/cancelado), o total lançado e o **arrecadado** (soma dos
// pagamentos) dos créditos não cancelados, e o **a receber** (saldo lançado − pago dos
// créditos ainda em cobrança: lancado + divida_ativa). Crédito cancelado não entra nos
// totais. Reusa taxes.read.
export const getTaxCreditsSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SummaryInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const row = (
      await query<{
        lancado: string;
        divida_ativa: string;
        quitado: string;
        cancelado: string;
        valor_lancado: string;
        arrecadado: string;
        a_receber: string;
      }>(
        `select
           count(*) filter (where status='lancado')::text as lancado,
           count(*) filter (where status='divida_ativa')::text as divida_ativa,
           count(*) filter (where status='quitado')::text as quitado,
           count(*) filter (where status='cancelado')::text as cancelado,
           coalesce(sum(valor_lancado) filter (where status <> 'cancelado'),0)::text as valor_lancado,
           coalesce(sum(valor_pago) filter (where status <> 'cancelado'),0)::text as arrecadado,
           coalesce(sum(valor_lancado - valor_pago) filter (where status in ('lancado','divida_ativa')),0)::text as a_receber
         from public.tax_credits where tenant_id = $1`,
        [data.tenant_id],
      )
    )[0];
    return {
      porStatus: {
        lancado: Number(row.lancado),
        divida_ativa: Number(row.divida_ativa),
        quitado: Number(row.quitado),
        cancelado: Number(row.cancelado),
      },
      valorLancado: Number(row.valor_lancado),
      arrecadado: Number(row.arrecadado),
      aReceber: Number(row.a_receber),
    };
  });

// O4-01c — Arrecadação por tributo. Agrupa os créditos não cancelados por tipo de tributo
// (IPTU/ISS/ITBI/TAXA/COSIP): quantidade, lançado e **arrecadado** (soma dos pagamentos).
// Ordena do mais arrecadado ao menos. Reusa taxes.read.
export const getTaxCreditsByTributo = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SummaryInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const rows = await query<{
      tributo: string;
      quantidade: string;
      lancado: string;
      arrecadado: string;
    }>(
      `select tributo, count(*)::text as quantidade,
         coalesce(sum(valor_lancado),0)::text as lancado,
         coalesce(sum(valor_pago),0)::text as arrecadado
       from public.tax_credits
       where tenant_id = $1 and status <> 'cancelado'
       group by tributo
       order by sum(valor_pago) desc, tributo`,
      [data.tenant_id],
    );
    return {
      tributos: rows.map((r) => ({
        tributo: r.tributo,
        quantidade: Number(r.quantidade),
        lancado: Number(r.lancado),
        arrecadado: Number(r.arrecadado),
      })),
    };
  });

export const getTaxCredits = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const credits = await query<{
      id: string;
      tributo: string;
      exercicio: number;
      contribuinte: string;
      inscricao: string;
      valor_lancado: string;
      valor_pago: string;
      saldo: string;
      vencimento: string;
      status: string;
    }>(
      `select id, tributo, exercicio, contribuinte, inscricao,
         valor_lancado::text, valor_pago::text,
         (valor_lancado - valor_pago)::text as saldo, vencimento::text, status
       from public.tax_credits
       where tenant_id = $1 and ($2::text is null or status = $2)
       order by exercicio desc, tributo, inscricao`,
      [data.tenant_id, data.status ?? null],
    );
    return {
      credits,
      canManage: access.permissions.includes("taxes.manage"),
    };
  });

const LaunchInput = z.object({
  tenant_id: z.string().uuid(),
  tributo: z.enum(["IPTU", "ISS", "ITBI", "TAXA", "COSIP"]),
  exercicio: z.number().int().min(2000).max(2200),
  contribuinte: z.string().trim().min(2).max(200),
  contribuinte_documento: z.string().trim().min(3).max(20),
  inscricao: z.string().trim().min(1).max(40),
  valor_lancado: z.number().positive().max(1_000_000_000_000),
  vencimento: z.string().date(),
});

export const launchTaxCredit = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => LaunchInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.tax_credits
       where tenant_id=$1 and tributo=$2 and exercicio=$3 and lower(inscricao)=lower($4)`,
      [data.tenant_id, data.tributo, data.exercicio, data.inscricao],
    );
    if (duplicate)
      throw new Error("Crédito já lançado para esta inscrição no exercício");
    const id = randomUUID();
    await withTransaction(async (client) => {
      await client.query(
        `insert into public.tax_credits
           (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
            inscricao, valor_lancado, vencimento, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          data.tenant_id,
          data.tributo,
          data.exercicio,
          data.contribuinte,
          data.contribuinte_documento,
          data.inscricao,
          data.valor_lancado,
          data.vencimento,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "launch",
        resource: "tax_credits",
        recordId: id,
        after: data,
      });
    });
    return { id };
  });

const PayInput = z.object({
  tenant_id: z.string().uuid(),
  credit_id: z.string().uuid(),
  data_pagamento: z.string().date(),
  valor: z.number().positive().max(1_000_000_000_000),
});

// Arrecada o tributo: soma ao pago (nunca acima do saldo); quita quando zera.
export const recordTaxPayment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => PayInput.parse(data))
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
      if (credit.status === "quitado")
        throw new Error("Crédito já está quitado");
      if (credit.status === "cancelado")
        throw new Error("Crédito cancelado não arrecada");
      const saldo = Number(credit.valor_lancado) - Number(credit.valor_pago);
      if (data.valor > saldo)
        throw new Error(
          `Pagamento (${data.valor.toFixed(2)}) excede o saldo devedor (${saldo.toFixed(2)})`,
        );
      const novoPago = Number(
        (Number(credit.valor_pago) + data.valor).toFixed(2),
      );
      const quitado = novoPago >= Number(credit.valor_lancado);
      const id = randomUUID();
      await client.query(
        `insert into public.tax_payments
           (id, tenant_id, credit_id, data_pagamento, valor, created_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          data.tenant_id,
          data.credit_id,
          data.data_pagamento,
          data.valor,
          context.userId,
        ],
      );
      await client.query(
        `update public.tax_credits
         set valor_pago=$3, status=case when $4 then 'quitado' else status end,
             updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.credit_id, data.tenant_id, novoPago, quitado],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "pay",
        resource: "tax_credits",
        recordId: data.credit_id,
        after: { valor: data.valor, quitado },
      });
      return { id, quitado, saldo: Number((saldo - data.valor).toFixed(2)) };
    });
  });

const InscribeInput = z.object({
  tenant_id: z.string().uuid(),
  credit_id: z.string().uuid(),
  data_referencia: z.string().date(),
});

// Inscreve em dívida ativa: crédito vencido e com saldo, não quitado (Lei 6.830).
export const inscribeDividaAtiva = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => InscribeInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const credit = (
        await client.query<{
          valor_lancado: string;
          valor_pago: string;
          vencimento: string;
          status: string;
        }>(
          `select valor_lancado::text, valor_pago::text, vencimento::text, status
           from public.tax_credits where id=$1 and tenant_id=$2 for update`,
          [data.credit_id, data.tenant_id],
        )
      ).rows[0];
      if (!credit) throw new Error("Crédito tributário não encontrado");
      if (credit.status !== "lancado")
        throw new Error("Só um crédito lançado pode ir a dívida ativa");
      if (Number(credit.valor_pago) >= Number(credit.valor_lancado))
        throw new Error("Crédito sem saldo devedor");
      if (data.data_referencia <= credit.vencimento)
        throw new Error("Crédito ainda não está vencido");
      await client.query(
        `update public.tax_credits set status='divida_ativa', updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.credit_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "inscribe_divida_ativa",
        resource: "tax_credits",
        recordId: data.credit_id,
        after: { data_referencia: data.data_referencia },
      });
      return { id: data.credit_id, status: "divida_ativa" };
    });
  });

const UpdatedDebtInput = z.object({
  tenant_id: z.string().uuid(),
  credit_id: z.string().uuid(),
  data_referencia: z.string().date(),
  // Encargos de mora parametrizáveis pelo ente (não presume código municipal).
  // Padrão: multa de mora 2% (uma vez) e juros de 1% ao mês (CTN art. 161, §1º).
  multa_percent: z.number().min(0).max(100).default(2),
  juros_mes_percent: z.number().min(0).max(100).default(1),
});

// O4-07 — Valor atualizado do crédito com encargos de mora. Sobre o saldo devedor
// (lançado − pago), a partir do vencimento, aplica multa de mora (uma vez) e juros de
// mora por mês (ou fração — mês comercial de 30 dias, fração conta como mês inteiro).
// Cálculo de PREVISÃO (não grava): as alíquotas vêm do ente, então é uma calculadora
// paramétrica, não uma declaração de conformidade com legislação específica.
export const getUpdatedTaxDebt = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => UpdatedDebtInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const credit = await queryOne<{
      valor_lancado: string;
      valor_pago: string;
      vencimento: string;
      status: string;
    }>(
      `select valor_lancado::text, valor_pago::text, vencimento::text, status
       from public.tax_credits where id=$1 and tenant_id=$2`,
      [data.credit_id, data.tenant_id],
    );
    if (!credit) throw new Error("Crédito tributário não encontrado");
    const saldo = Number(
      (Number(credit.valor_lancado) - Number(credit.valor_pago)).toFixed(2),
    );
    const n2 = (v: number) => Number(v.toFixed(2));

    // Sem saldo ou ainda não vencido (na data de referência): sem encargos.
    if (saldo <= 0 || data.data_referencia <= credit.vencimento) {
      return {
        saldo: Math.max(0, saldo),
        dias_atraso: 0,
        meses_mora: 0,
        multa: 0,
        juros: 0,
        valor_atualizado: Math.max(0, saldo),
      };
    }

    const umDia = 86_400_000;
    const diasAtraso = Math.round(
      (Date.parse(data.data_referencia) - Date.parse(credit.vencimento)) /
        umDia,
    );
    // Mês ou fração: cada 30 dias iniciados conta como um mês de mora.
    const mesesMora = Math.ceil(diasAtraso / 30);
    const multa = n2(saldo * (data.multa_percent / 100));
    const juros = n2(saldo * (data.juros_mes_percent / 100) * mesesMora);
    return {
      saldo,
      dias_atraso: diasAtraso,
      meses_mora: mesesMora,
      multa,
      juros,
      valor_atualizado: n2(saldo + multa + juros),
    };
  });

const CancelInput = z.object({
  tenant_id: z.string().uuid(),
  credit_id: z.string().uuid(),
  motivo: z.string().trim().min(3).max(500),
  data_cancelamento: z.string().date(),
});

// O4-13 — Cancela o crédito tributário (isenção, anistia, remissão, decisão). Um crédito
// já quitado ou cancelado não cancela; um crédito com parcelamento ativo tem de ter o
// plano rescindido antes (evita cancelar dívida em cobrança amigável). Reusa taxes.manage.
export const cancelTaxCredit = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CancelInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const credit = (
        await client.query<{ status: string }>(
          `select status from public.tax_credits
           where id=$1 and tenant_id=$2 for update`,
          [data.credit_id, data.tenant_id],
        )
      ).rows[0];
      if (!credit) throw new Error("Crédito tributário não encontrado");
      if (credit.status === "quitado")
        throw new Error("Crédito quitado não pode ser cancelado");
      if (credit.status === "cancelado")
        throw new Error("Crédito já está cancelado");
      const planoAtivo = await client.query(
        `select id from public.tax_installment_plans
         where tenant_id=$1 and credit_id=$2 and status='ativo'`,
        [data.tenant_id, data.credit_id],
      );
      if (planoAtivo.rows.length)
        throw new Error(
          "Rescinda o parcelamento ativo antes de cancelar o crédito",
        );
      await client.query(
        `update public.tax_credits set status='cancelado', updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.credit_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "cancelar_credito",
        resource: "tax_credits",
        recordId: data.credit_id,
        after: {
          motivo: data.motivo,
          data_cancelamento: data.data_cancelamento,
        },
      });
      return { id: data.credit_id, status: "cancelado" };
    });
  });

const PaymentsInput = z.object({
  tenant_id: z.string().uuid(),
  credit_id: z.string().uuid(),
});

// O4-01d — Extrato (razão) de pagamentos de um crédito tributário. Lista os
// pagamentos do crédito em ordem cronológica, com o **saldo devedor após** cada um
// (lançado − Σpago até ali), e devolve o total pago e o saldo atual — a trilha de
// arrecadação do crédito, isolada por `credit_id`. Read-only, reusa taxes.read.
export const getTaxCreditPayments = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => PaymentsInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const credit = await queryOne<{ valor_lancado: string }>(
      `select valor_lancado::text from public.tax_credits
       where id=$1 and tenant_id=$2`,
      [data.credit_id, data.tenant_id],
    );
    if (!credit) throw new Error("Crédito tributário não encontrado");
    const rows = await query<{
      id: string;
      data_pagamento: string;
      valor: string;
    }>(
      `select id, data_pagamento::text, valor::text
       from public.tax_payments
       where tenant_id=$1 and credit_id=$2
       order by data_pagamento, created_at, id`,
      [data.tenant_id, data.credit_id],
    );
    const lancado = Number(credit.valor_lancado);
    let acumulado = 0;
    const pagamentos = rows.map((r) => {
      acumulado = Number((acumulado + Number(r.valor)).toFixed(2));
      return {
        id: r.id,
        data_pagamento: r.data_pagamento,
        valor: Number(r.valor),
        saldo_apos: Number((lancado - acumulado).toFixed(2)),
      };
    });
    return {
      valor_lancado: lancado,
      total_pago: acumulado,
      saldo: Number((lancado - acumulado).toFixed(2)),
      pagamentos,
    };
  });
