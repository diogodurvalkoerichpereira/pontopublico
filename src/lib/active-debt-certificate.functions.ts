// O4-08 — Certidão de Dívida Ativa (CDA, Onda 4, Lei 6.830 art. 2º). Registra a CDA de
// um crédito já inscrito em dívida ativa: numera por ente/exercício (linha-contador
// travada) e fixa o saldo inscrito (título executivo). É o REGISTRO da CDA — não emite
// documento autenticado, código de validação nem assinatura. Reusa taxes.*.
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

const GetInput = z.object({ tenant_id: z.string().uuid() });

export const getActiveDebtCertificates = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const certificates = await query<{
      id: string;
      exercicio: number;
      numero: string;
      credit_id: string;
      valor_inscrito: string;
      data_inscricao: string;
      fundamento_legal: string;
      status: string;
    }>(
      `select c.id, c.exercicio, c.numero::text, c.credit_id,
         c.valor_inscrito::text, c.data_inscricao::text, c.fundamento_legal, c.status
       from public.active_debt_certificates c
       where c.tenant_id = $1
       order by c.exercicio desc, c.numero desc`,
      [data.tenant_id],
    );
    return {
      certificates,
      canManage: access.permissions.includes("taxes.manage"),
    };
  });

// O4-14 — Consolidação da dívida ativa por contribuinte. Junta as CDAs ao crédito de
// origem e agrupa por documento do contribuinte: quantidade de CDAs, total inscrito e o
// recorte por situação (ativa/quitada/cancelada). O saldo em cobrança considera SÓ as
// CDAs 'ativa' — quitadas e canceladas não são estoque de dívida. Reusa taxes.read.
export const getActiveDebtByTaxpayer = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const rows = await query<{
      contribuinte: string;
      contribuinte_documento: string;
      qtd_cdas: string;
      total_inscrito: string;
      total_ativa: string;
      total_quitada: string;
      total_cancelada: string;
    }>(
      `select tc.contribuinte, tc.contribuinte_documento,
         count(*)::text as qtd_cdas,
         coalesce(sum(c.valor_inscrito),0)::text as total_inscrito,
         coalesce(sum(c.valor_inscrito) filter (where c.status='ativa'),0)::text as total_ativa,
         coalesce(sum(c.valor_inscrito) filter (where c.status='quitada'),0)::text as total_quitada,
         coalesce(sum(c.valor_inscrito) filter (where c.status='cancelada'),0)::text as total_cancelada
       from public.active_debt_certificates c
       join public.tax_credits tc on tc.id = c.credit_id
       where c.tenant_id = $1
       group by tc.contribuinte, tc.contribuinte_documento
       order by total_ativa desc, tc.contribuinte`,
      [data.tenant_id],
    );
    const contribuintes = rows.map((r) => ({
      contribuinte: r.contribuinte,
      contribuinte_documento: r.contribuinte_documento,
      qtd_cdas: Number(r.qtd_cdas),
      total_inscrito: Number(r.total_inscrito),
      total_ativa: Number(r.total_ativa),
      total_quitada: Number(r.total_quitada),
      total_cancelada: Number(r.total_cancelada),
    }));
    const round2 = (v: number) => Number(v.toFixed(2));
    const saldoEmCobranca = round2(
      contribuintes.reduce((s, c) => s + c.total_ativa, 0),
    );
    return { contribuintes, saldoEmCobranca };
  });

const EmitInput = z.object({
  tenant_id: z.string().uuid(),
  credit_id: z.string().uuid(),
  data_inscricao: z.string().date(),
  fundamento_legal: z.string().trim().min(3).max(200).optional(),
});

// Emite (registra) a CDA do crédito inscrito em dívida ativa. Só um crédito em
// 'divida_ativa' com saldo devedor; uma CDA por crédito (unique + guarda de estado).
export const emitActiveDebtCertificate = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => EmitInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const credit = (
        await client.query<{
          exercicio: number;
          valor_lancado: string;
          valor_pago: string;
          status: string;
        }>(
          `select exercicio, valor_lancado::text, valor_pago::text, status
           from public.tax_credits where id=$1 and tenant_id=$2 for update`,
          [data.credit_id, data.tenant_id],
        )
      ).rows[0];
      if (!credit) throw new Error("Crédito tributário não encontrado");
      if (credit.status !== "divida_ativa")
        throw new Error("Só um crédito em dívida ativa recebe CDA");
      const saldo = Number(
        (Number(credit.valor_lancado) - Number(credit.valor_pago)).toFixed(2),
      );
      if (saldo <= 0) throw new Error("Crédito sem saldo devedor");

      const dup = await client.query(
        `select id from public.active_debt_certificates
         where tenant_id=$1 and credit_id=$2`,
        [data.tenant_id, data.credit_id],
      );
      if (dup.rows.length) throw new Error("Crédito já possui CDA");

      // Numeração sequencial por ente/exercício (linha-contador travada).
      await client.query(
        `insert into public.active_debt_certificate_counters (tenant_id, exercicio)
         values ($1, $2) on conflict do nothing`,
        [data.tenant_id, credit.exercicio],
      );
      const counter = (
        await client.query<{ last_numero: string }>(
          `select last_numero::text from public.active_debt_certificate_counters
           where tenant_id=$1 and exercicio=$2 for update`,
          [data.tenant_id, credit.exercicio],
        )
      ).rows[0];
      const numero = Number(counter.last_numero) + 1;
      await client.query(
        `update public.active_debt_certificate_counters set last_numero=$3
         where tenant_id=$1 and exercicio=$2`,
        [data.tenant_id, credit.exercicio, numero],
      );

      const id = randomUUID();
      await client.query(
        `insert into public.active_debt_certificates
           (id, tenant_id, exercicio, numero, credit_id, valor_inscrito,
            data_inscricao, fundamento_legal, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'Lei 6.830, art. 2o'),$9)`,
        [
          id,
          data.tenant_id,
          credit.exercicio,
          numero,
          data.credit_id,
          saldo,
          data.data_inscricao,
          data.fundamento_legal ?? null,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "emit_cda",
        resource: "active_debt_certificates",
        recordId: id,
        after: { numero, valor_inscrito: saldo },
      });
      return { id, numero, valor_inscrito: saldo };
    });
  });

const SettleInput = z.object({
  tenant_id: z.string().uuid(),
  certificate_id: z.string().uuid(),
});

// O4-08b — Baixa a CDA por quitação. Só uma CDA **ativa** cujo crédito de origem esteja
// integralmente pago (saldo devedor ≤ 0) passa a 'quitada' — deixa o estoque em cobrança
// (o saldo consolidado só soma CDAs ativas), fechando a incoerência de manter em cobrança
// um crédito já pago. Ativa o status 'quitada' que existia no enum mas nada gravava. Reusa
// taxes.manage.
export const settleActiveDebtCertificate = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SettleInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const cda = (
        await client.query<{ status: string; credit_id: string }>(
          `select status, credit_id from public.active_debt_certificates
           where id=$1 and tenant_id=$2 for update`,
          [data.certificate_id, data.tenant_id],
        )
      ).rows[0];
      if (!cda) throw new Error("CDA não encontrada");
      if (cda.status !== "ativa")
        throw new Error("Só uma CDA ativa pode ser baixada por quitação");
      const credit = (
        await client.query<{ valor_lancado: string; valor_pago: string }>(
          `select valor_lancado::text, valor_pago::text
           from public.tax_credits where id=$1 and tenant_id=$2`,
          [cda.credit_id, data.tenant_id],
        )
      ).rows[0];
      if (!credit) throw new Error("Crédito tributário não encontrado");
      const saldo = Number(
        (Number(credit.valor_lancado) - Number(credit.valor_pago)).toFixed(2),
      );
      if (saldo > 0)
        throw new Error(
          "A CDA só é baixada quando o crédito está integralmente pago",
        );
      await client.query(
        `update public.active_debt_certificates set status='quitada'
         where id=$1 and tenant_id=$2`,
        [data.certificate_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "quitar_cda",
        resource: "active_debt_certificates",
        recordId: data.certificate_id,
        after: { status: "quitada" },
      });
      return { id: data.certificate_id, status: "quitada" };
    });
  });

const CancelInput = z.object({
  tenant_id: z.string().uuid(),
  certificate_id: z.string().uuid(),
  motivo: z.string().trim().min(3).max(500),
});

// O4-08c — Cancela (baixa por cancelamento) uma CDA ativa: prescrição/decadência, erro de
// inscrição ou determinação judicial (Lei 6.830). A CDA sai do estoque em cobrança; o
// crédito de origem segue seu próprio ciclo (o cancelamento da inscrição não o extingue
// automaticamente). Ativa o status 'cancelada'. Reusa taxes.manage.
export const cancelActiveDebtCertificate = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CancelInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const cda = (
        await client.query<{ status: string }>(
          `select status from public.active_debt_certificates
           where id=$1 and tenant_id=$2 for update`,
          [data.certificate_id, data.tenant_id],
        )
      ).rows[0];
      if (!cda) throw new Error("CDA não encontrada");
      if (cda.status !== "ativa")
        throw new Error("Só uma CDA ativa pode ser cancelada");
      await client.query(
        `update public.active_debt_certificates set status='cancelada'
         where id=$1 and tenant_id=$2`,
        [data.certificate_id, data.tenant_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "cancelar_cda",
        resource: "active_debt_certificates",
        recordId: data.certificate_id,
        after: { status: "cancelada", motivo: data.motivo },
      });
      return { id: data.certificate_id, status: "cancelada" };
    });
  });

const AgingInput = z.object({
  tenant_id: z.string().uuid(),
  ano_referencia: z.number().int().min(2000).max(2200),
});

// O4-14b — Aging (idade) do estoque da dívida ativa. Distribui as CDAs em cobrança
// (status 'ativa') por **exercício de origem** e por **faixa etária** (idade = ano de
// referência − exercício): no exercício, 1–2, 3–5 e mais de 5 anos — a base para a provisão
// para perdas (PDD, NBC TSP) e para priorizar a cobrança, que a consolidação por
// contribuinte não dá. Só CDA ativa é estoque. Read-only, reusa taxes.read.
export const getActiveDebtAging = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => AgingInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const rows = await query<{
      exercicio: number;
      quantidade: string;
      valor: string;
    }>(
      `select exercicio, count(*)::text as quantidade,
         coalesce(sum(valor_inscrito),0)::text as valor
       from public.active_debt_certificates
       where tenant_id = $1 and status = 'ativa'
       group by exercicio
       order by exercicio`,
      [data.tenant_id],
    );
    const round2 = (v: number) => Number(v.toFixed(2));
    const porExercicio = rows.map((r) => ({
      exercicio: r.exercicio,
      quantidade: Number(r.quantidade),
      valor: round2(Number(r.valor)),
      idade: data.ano_referencia - r.exercicio,
    }));
    const faixa = (idade: number) =>
      idade <= 0
        ? "no_exercicio"
        : idade <= 2
          ? "de_1_a_2"
          : idade <= 5
            ? "de_3_a_5"
            : "mais_de_5";
    const faixas = {
      no_exercicio: { quantidade: 0, valor: 0 },
      de_1_a_2: { quantidade: 0, valor: 0 },
      de_3_a_5: { quantidade: 0, valor: 0 },
      mais_de_5: { quantidade: 0, valor: 0 },
    };
    for (const e of porExercicio) {
      const f = faixas[faixa(e.idade)];
      f.quantidade += e.quantidade;
      f.valor = round2(f.valor + e.valor);
    }
    return {
      ano_referencia: data.ano_referencia,
      porExercicio,
      faixas,
      total: {
        quantidade: porExercicio.reduce((s, e) => s + e.quantidade, 0),
        valor: round2(porExercicio.reduce((s, e) => s + e.valor, 0)),
      },
    };
  });
