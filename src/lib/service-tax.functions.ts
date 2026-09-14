// O4-05 — Cadastro mobiliário e lançamento de ISS (Onda 4). Cada prestador tem
// inscrição municipal, atividade e alíquota de ISS. O lançamento por competência
// gera um crédito tributário (tax_credits, O4-01) = base de cálculo × alíquota,
// com inscrição do crédito no formato "inscricao/competencia" (um por competência).
// Reusa taxes.*.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const TenantInput = z.object({ tenant_id: z.string().uuid() });

export const getServiceTaxpayers = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TenantInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const taxpayers = await query<{
      id: string;
      inscricao_municipal: string;
      razao_social: string;
      atividade: string;
      aliquota_iss: string;
      status: string;
    }>(
      `select id, inscricao_municipal, razao_social, atividade,
         aliquota_iss::text, status
       from public.service_taxpayers
       where tenant_id = $1 order by inscricao_municipal`,
      [data.tenant_id],
    );
    return {
      taxpayers,
      canManage: access.permissions.includes("taxes.manage"),
    };
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  inscricao_municipal: z.string().trim().min(1).max(40),
  razao_social: z.string().trim().min(2).max(200),
  documento: z.string().trim().min(3).max(20),
  atividade: z.string().trim().min(2).max(200),
  aliquota_iss: z.number().positive().max(5),
  status: z.enum(["ativo", "baixado"]).default("ativo"),
});

export const saveServiceTaxpayer = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.service_taxpayers
       where tenant_id=$1 and lower(inscricao_municipal)=lower($2)
         and ($3::uuid is null or id<>$3)`,
      [data.tenant_id, data.inscricao_municipal, data.id ?? null],
    );
    if (duplicate) throw new Error("Inscrição municipal já cadastrada");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.service_taxpayers
           set inscricao_municipal=$3, razao_social=$4, documento=$5, atividade=$6,
               aliquota_iss=$7, status=$8, updated_at=now()
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.inscricao_municipal,
            data.razao_social,
            data.documento,
            data.atividade,
            data.aliquota_iss,
            data.status,
          ],
        );
      } else {
        await client.query(
          `insert into public.service_taxpayers
             (id, tenant_id, inscricao_municipal, razao_social, documento,
              atividade, aliquota_iss, status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            data.tenant_id,
            data.inscricao_municipal,
            data.razao_social,
            data.documento,
            data.atividade,
            data.aliquota_iss,
            data.status,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "service_taxpayers",
        recordId: id,
        after: { inscricao: data.inscricao_municipal },
      });
    });
    return { id };
  });

const IssInput = z.object({
  tenant_id: z.string().uuid(),
  taxpayer_id: z.string().uuid(),
  competencia: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "competência deve ser AAAA-MM"),
  base_calculo: z.number().positive().max(1_000_000_000_000),
  // Alíquota opcional: usa a do cadastro quando ausente.
  aliquota: z.number().positive().max(5).optional(),
  vencimento: z.string().date(),
});

// Lança o ISS da competência: crédito = base × alíquota (%), gravado em tax_credits
// com inscrição "inscricao_municipal/competencia" (um lançamento por competência).
export const launchIss = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(IssInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    const exercicio = Number(data.competencia.slice(0, 4));
    return withTransaction(async (client) => {
      const taxpayer = (
        await client.query<{
          inscricao_municipal: string;
          razao_social: string;
          documento: string;
          aliquota_iss: string;
          status: string;
        }>(
          `select inscricao_municipal, razao_social, documento, aliquota_iss::text,
             status
           from public.service_taxpayers where id=$1 and tenant_id=$2 for update`,
          [data.taxpayer_id, data.tenant_id],
        )
      ).rows[0];
      if (!taxpayer) throw new Error("Contribuinte não encontrado");
      if (taxpayer.status !== "ativo")
        throw new Error("Contribuinte baixado não lança ISS");
      const aliquota = data.aliquota ?? Number(taxpayer.aliquota_iss);
      const inscricao = `${taxpayer.inscricao_municipal}/${data.competencia}`;
      const dup = await client.query(
        `select id from public.tax_credits
         where tenant_id=$1 and tributo='ISS' and exercicio=$2
           and lower(inscricao)=lower($3)`,
        [data.tenant_id, exercicio, inscricao],
      );
      if (dup.rows.length)
        throw new Error("ISS já lançado para esta competência");
      const valor = Number(((data.base_calculo * aliquota) / 100).toFixed(2));
      if (valor <= 0) throw new Error("Valor do ISS calculado é zero");
      const creditId = randomUUID();
      await client.query(
        `insert into public.tax_credits
           (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
            inscricao, valor_lancado, vencimento, created_by)
         values ($1,$2,'ISS',$3,$4,$5,$6,$7,$8,$9)`,
        [
          creditId,
          data.tenant_id,
          exercicio,
          taxpayer.razao_social,
          taxpayer.documento,
          inscricao,
          valor,
          data.vencimento,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "launch_iss",
        resource: "tax_credits",
        recordId: creditId,
        after: { competencia: data.competencia, aliquota, valor },
      });
      return { credit_id: creditId, valor };
    });
  });
