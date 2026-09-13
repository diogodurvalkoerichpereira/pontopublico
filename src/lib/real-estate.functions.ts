// O4-04 — Cadastro imobiliário e lançamento de IPTU (Onda 4). Cada imóvel tem
// inscrição, proprietário, valor venal e áreas. O lançamento do IPTU gera um
// crédito tributário (tax_credits, O4-01) = valor venal × alíquota, ligando o
// cadastro à arrecadação. Reusa taxes.*.
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

export const getProperties = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const properties = await query<{
      id: string;
      inscricao_imobiliaria: string;
      proprietario: string;
      endereco: string;
      valor_venal: string;
      status: string;
    }>(
      `select id, inscricao_imobiliaria, proprietario, endereco,
         valor_venal::text, status
       from public.real_estate_properties
       where tenant_id = $1 order by inscricao_imobiliaria`,
      [data.tenant_id],
    );
    return {
      properties,
      canManage: access.permissions.includes("taxes.manage"),
    };
  });

// O4-04b — Resumo do cadastro imobiliário. Consolida a contagem de imóveis por situação
// (ativo/baixado) e, dos **ativos**, o valor venal total e a área construída — a **base
// tributável** do IPTU. Imóvel baixado não integra a base. Read-only, reusa taxes.read.
export const getRealEstateSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.read");
    const row = (
      await query<{
        ativos: string;
        baixados: string;
        valor_venal: string;
        area_construida: string;
      }>(
        `select
           count(*) filter (where status='ativo')::text as ativos,
           count(*) filter (where status='baixado')::text as baixados,
           coalesce(sum(valor_venal) filter (where status='ativo'),0)::text as valor_venal,
           coalesce(sum(area_construida) filter (where status='ativo'),0)::text as area_construida
         from public.real_estate_properties
         where tenant_id = $1`,
        [data.tenant_id],
      )
    )[0];
    return {
      ativos: Number(row.ativos),
      baixados: Number(row.baixados),
      valorVenalTributavel: Number(Number(row.valor_venal).toFixed(2)),
      areaConstruidaTotal: Number(Number(row.area_construida).toFixed(2)),
    };
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  inscricao_imobiliaria: z.string().trim().min(1).max(40),
  proprietario: z.string().trim().min(2).max(200),
  proprietario_documento: z.string().trim().min(3).max(20),
  endereco: z.string().trim().min(3).max(300),
  valor_venal: z.number().positive().max(1_000_000_000_000),
  area_terreno: z.number().min(0).max(100_000_000).nullable().optional(),
  area_construida: z.number().min(0).max(100_000_000).nullable().optional(),
  status: z.enum(["ativo", "baixado"]).default("ativo"),
});

export const savePropertyRegistration = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.real_estate_properties
       where tenant_id=$1 and lower(inscricao_imobiliaria)=lower($2)
         and ($3::uuid is null or id<>$3)`,
      [data.tenant_id, data.inscricao_imobiliaria, data.id ?? null],
    );
    if (duplicate) throw new Error("Inscrição imobiliária já cadastrada");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.real_estate_properties
           set inscricao_imobiliaria=$3, proprietario=$4, proprietario_documento=$5,
               endereco=$6, valor_venal=$7, area_terreno=$8, area_construida=$9,
               status=$10, updated_at=now()
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.inscricao_imobiliaria,
            data.proprietario,
            data.proprietario_documento,
            data.endereco,
            data.valor_venal,
            data.area_terreno ?? null,
            data.area_construida ?? null,
            data.status,
          ],
        );
      } else {
        await client.query(
          `insert into public.real_estate_properties
             (id, tenant_id, inscricao_imobiliaria, proprietario,
              proprietario_documento, endereco, valor_venal, area_terreno,
              area_construida, status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            data.tenant_id,
            data.inscricao_imobiliaria,
            data.proprietario,
            data.proprietario_documento,
            data.endereco,
            data.valor_venal,
            data.area_terreno ?? null,
            data.area_construida ?? null,
            data.status,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "real_estate_properties",
        recordId: id,
        after: {
          inscricao: data.inscricao_imobiliaria,
          valor_venal: data.valor_venal,
        },
      });
    });
    return { id };
  });

const IptuInput = z.object({
  tenant_id: z.string().uuid(),
  property_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
  aliquota: z.number().positive().max(15),
  vencimento: z.string().date(),
});

// Lança o IPTU do imóvel no exercício: crédito = valor venal × alíquota (%),
// gravado em tax_credits. Um lançamento por imóvel/exercício.
export const launchIptu = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => IptuInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      const property = (
        await client.query<{
          inscricao_imobiliaria: string;
          proprietario: string;
          proprietario_documento: string;
          valor_venal: string;
          status: string;
        }>(
          `select inscricao_imobiliaria, proprietario, proprietario_documento,
             valor_venal::text, status
           from public.real_estate_properties
           where id=$1 and tenant_id=$2 for update`,
          [data.property_id, data.tenant_id],
        )
      ).rows[0];
      if (!property) throw new Error("Imóvel não encontrado");
      if (property.status !== "ativo")
        throw new Error("Imóvel baixado não lança IPTU");
      const dup = await client.query(
        `select id from public.tax_credits
         where tenant_id=$1 and tributo='IPTU' and exercicio=$2
           and lower(inscricao)=lower($3)`,
        [data.tenant_id, data.exercicio, property.inscricao_imobiliaria],
      );
      if (dup.rows.length)
        throw new Error("IPTU já lançado para este imóvel no exercício");
      const valor = Number(
        ((Number(property.valor_venal) * data.aliquota) / 100).toFixed(2),
      );
      if (valor <= 0) throw new Error("Valor do IPTU calculado é zero");
      const creditId = randomUUID();
      await client.query(
        `insert into public.tax_credits
           (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
            inscricao, valor_lancado, vencimento, created_by)
         values ($1,$2,'IPTU',$3,$4,$5,$6,$7,$8,$9)`,
        [
          creditId,
          data.tenant_id,
          data.exercicio,
          property.proprietario,
          property.proprietario_documento,
          property.inscricao_imobiliaria,
          valor,
          data.vencimento,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "launch_iptu",
        resource: "tax_credits",
        recordId: creditId,
        after: {
          property_id: data.property_id,
          exercicio: data.exercicio,
          aliquota: data.aliquota,
          valor,
        },
      });
      return { credit_id: creditId, valor };
    });
  });

const IptuBatchInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
  aliquota: z.number().positive().max(15),
  vencimento: z.string().date(),
});

// O4-04b — Lançamento em massa do IPTU do exercício. Gera o crédito (valor venal ×
// alíquota) de TODOS os imóveis ativos que ainda não têm IPTU lançado no exercício —
// a rotina de abertura do exercício, que o lançamento avulso (um imóvel por vez) não
// cobria. Imóvel já lançado ou com valor calculado ≤ 0 é ignorado (não bloqueia o lote).
// Devolve quantos foram lançados, quantos foram ignorados e o total lançado. Reusa
// taxes.manage.
export const launchIptuBatch = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => IptuBatchInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    return withTransaction(async (client) => {
      // Imóveis ativos sem IPTU do exercício (compara inscrição sem diferenciar caixa).
      const pendentes = (
        await client.query<{
          id: string;
          inscricao_imobiliaria: string;
          proprietario: string;
          proprietario_documento: string;
          valor_venal: string;
        }>(
          `select p.id, p.inscricao_imobiliaria, p.proprietario,
             p.proprietario_documento, p.valor_venal::text
           from public.real_estate_properties p
           where p.tenant_id=$1 and p.status='ativo'
             and not exists (
               select 1 from public.tax_credits tc
               where tc.tenant_id=p.tenant_id and tc.tributo='IPTU'
                 and tc.exercicio=$2
                 and lower(tc.inscricao)=lower(p.inscricao_imobiliaria)
             )
           order by p.inscricao_imobiliaria, p.id`,
          [data.tenant_id, data.exercicio],
        )
      ).rows;

      let lancados = 0;
      let ignorados = 0;
      let totalValor = 0;
      for (const p of pendentes) {
        const valor = Number(
          ((Number(p.valor_venal) * data.aliquota) / 100).toFixed(2),
        );
        // Sem base de cálculo (valor venal zerado) não gera crédito.
        if (valor <= 0) {
          ignorados += 1;
          continue;
        }
        await client.query(
          `insert into public.tax_credits
             (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
              inscricao, valor_lancado, vencimento, created_by)
           values ($1,$2,'IPTU',$3,$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            data.tenant_id,
            data.exercicio,
            p.proprietario,
            p.proprietario_documento,
            p.inscricao_imobiliaria,
            valor,
            data.vencimento,
            context.userId,
          ],
        );
        lancados += 1;
        totalValor = Number((totalValor + valor).toFixed(2));
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "launch_iptu_batch",
        resource: "tax_credits",
        recordId: data.tenant_id,
        after: {
          exercicio: data.exercicio,
          aliquota: data.aliquota,
          lancados,
          ignorados,
          total_valor: totalValor,
        },
      });
      return { lancados, ignorados, total_valor: totalValor };
    });
  });
