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
