// O3-03 — Patrimônio (Onda 3). Bens patrimoniais e depreciação linear (NBC TSP).
// A depreciação nunca ultrapassa a base depreciável (aquisição − residual).
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

const round2 = (v: number) => Number(v.toFixed(2));
const TenantInput = z.object({ tenant_id: z.string().uuid() });

export const getAssets = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "assets.read");
    const assets = await query<{
      id: string;
      tombamento: string;
      descricao: string;
      valor_aquisicao: string;
      valor_residual: string;
      vida_util_meses: number;
      meses_depreciados: number;
      depreciacao_acumulada: string;
      valor_liquido: string;
      status: string;
    }>(
      `select id, tombamento, descricao, valor_aquisicao::text,
         valor_residual::text, vida_util_meses, meses_depreciados,
         depreciacao_acumulada::text,
         (valor_aquisicao - depreciacao_acumulada)::text as valor_liquido, status
       from public.patrimony_assets where tenant_id = $1 order by tombamento`,
      [data.tenant_id],
    );
    return {
      assets,
      canManage: access.permissions.includes("assets.manage"),
    };
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  tombamento: z.string().trim().min(1).max(40),
  descricao: z.string().trim().min(2).max(300),
  valor_aquisicao: z.number().positive().max(1_000_000_000_000),
  valor_residual: z.number().min(0).max(1_000_000_000_000).default(0),
  vida_util_meses: z.number().int().positive().max(1200),
  data_aquisicao: z.string().date(),
  status: z.enum(["ativo", "baixado"]).default("ativo"),
});

export const saveAsset = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "assets.manage");
    if (data.valor_residual > data.valor_aquisicao)
      throw new Error("Valor residual não pode exceder o de aquisição");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.patrimony_assets
       where tenant_id=$1 and lower(tombamento)=lower($2)
         and ($3::uuid is null or id<>$3)`,
      [data.tenant_id, data.tombamento, data.id ?? null],
    );
    if (duplicate) throw new Error("Tombamento já utilizado");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.patrimony_assets set tombamento=$3, descricao=$4,
             valor_aquisicao=$5, valor_residual=$6, vida_util_meses=$7,
             data_aquisicao=$8, status=$9, updated_at=now()
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.tombamento,
            data.descricao,
            data.valor_aquisicao,
            data.valor_residual,
            data.vida_util_meses,
            data.data_aquisicao,
            data.status,
          ],
        );
      } else {
        await client.query(
          `insert into public.patrimony_assets
             (id, tenant_id, tombamento, descricao, valor_aquisicao,
              valor_residual, vida_util_meses, data_aquisicao, status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            data.tenant_id,
            data.tombamento,
            data.descricao,
            data.valor_aquisicao,
            data.valor_residual,
            data.vida_util_meses,
            data.data_aquisicao,
            data.status,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "patrimony_assets",
        recordId: id,
        after: data,
      });
    });
    return { id };
  });

const IncorporateInput = z.object({
  tenant_id: z.string().uuid(),
  item_id: z.string().uuid(),
  quantidade: z.number().positive().max(1_000_000),
  tombamento: z.string().trim().min(1).max(40),
  descricao: z.string().trim().min(2).max(300).optional(),
  vida_util_meses: z.number().int().positive().max(1200),
  valor_residual: z.number().min(0).max(1_000_000_000_000).default(0),
  data_aquisicao: z.string().date(),
});

// O3-19 — Incorporação de material permanente ao patrimônio (liga O3-02 ↔ O3-03). Dá
// baixa da quantidade no almoxarifado (a custo médio do saldo) e cria o bem patrimonial
// correspondente com valor de aquisição = custo médio × quantidade. Só material
// 'permanente' e com saldo suficiente incorpora; o tombamento não se repete. Exige
// materials.manage (baixa o estoque) e assets.manage (cria o bem).
export const incorporateMaterialAsset = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => IncorporateInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "materials.manage");
    requireTenantPermission(access, "assets.manage");
    if (data.valor_residual < 0)
      throw new Error("Valor residual não pode ser negativo");
    return withTransaction(async (client) => {
      const item = (
        await client.query<{
          categoria: string;
          saldo_quantidade: string;
          saldo_valor: string;
        }>(
          `select categoria, saldo_quantidade::text, saldo_valor::text
           from public.material_items where id=$1 and tenant_id=$2 for update`,
          [data.item_id, data.tenant_id],
        )
      ).rows[0];
      if (!item) throw new Error("Material não encontrado");
      if (item.categoria !== "permanente")
        throw new Error("Só material permanente vira bem patrimonial");
      const saldoQtd = Number(item.saldo_quantidade);
      const saldoValor = Number(item.saldo_valor);
      if (data.quantidade > saldoQtd)
        throw new Error(
          `Quantidade (${data.quantidade}) excede o saldo em estoque (${saldoQtd})`,
        );
      const custoMedio = saldoQtd > 0 ? saldoValor / saldoQtd : 0;
      const valorAquisicao = round2(custoMedio * data.quantidade);
      if (data.valor_residual > valorAquisicao)
        throw new Error("Valor residual não pode exceder o de aquisição");

      const dupTomb = await client.query(
        `select id from public.patrimony_assets
         where tenant_id=$1 and lower(tombamento)=lower($2)`,
        [data.tenant_id, data.tombamento],
      );
      if (dupTomb.rows.length) throw new Error("Tombamento já utilizado");

      // Baixa do estoque (saída a custo médio).
      const novaQtd = Number((saldoQtd - data.quantidade).toFixed(3));
      const novoValor = round2(saldoValor - custoMedio * data.quantidade);
      const movId = randomUUID();
      await client.query(
        `insert into public.material_movements
           (id, tenant_id, item_id, tipo, quantidade, valor_unitario,
            data_movimento, historico, created_by)
         values ($1,$2,$3,'saida',$4,$5,$6,$7,$8)`,
        [
          movId,
          data.tenant_id,
          data.item_id,
          data.quantidade,
          round2(custoMedio),
          data.data_aquisicao,
          `Incorporacao ao patrimonio (tombamento ${data.tombamento})`,
          context.userId,
        ],
      );
      await client.query(
        `update public.material_items
         set saldo_quantidade=$3, saldo_valor=$4, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.item_id, data.tenant_id, novaQtd, novoValor],
      );

      // Cria o bem patrimonial.
      const assetId = randomUUID();
      const descricao = data.descricao ?? `Bem incorporado do material`;
      await client.query(
        `insert into public.patrimony_assets
           (id, tenant_id, tombamento, descricao, valor_aquisicao,
            valor_residual, vida_util_meses, data_aquisicao, status, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'ativo',$9)`,
        [
          assetId,
          data.tenant_id,
          data.tombamento,
          descricao,
          valorAquisicao,
          data.valor_residual,
          data.vida_util_meses,
          data.data_aquisicao,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "incorporate",
        resource: "patrimony_assets",
        recordId: assetId,
        after: {
          item_id: data.item_id,
          quantidade: data.quantidade,
          valor_aquisicao: valorAquisicao,
          tombamento: data.tombamento,
        },
      });
      return {
        asset_id: assetId,
        valor_aquisicao: valorAquisicao,
        saldo_quantidade: novaQtd,
      };
    });
  });

const DepreciateInput = z.object({
  tenant_id: z.string().uuid(),
  asset_id: z.string().uuid(),
  meses: z.number().int().positive().max(1200),
});

// Deprecia o bem por `meses`, linear. A acumulada nunca passa da base depreciável
// (aquisição − residual); os meses efetivamente depreciados respeitam a vida útil.
export const depreciateAsset = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => DepreciateInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "assets.manage");
    return withTransaction(async (client) => {
      const asset = (
        await client.query<{
          valor_aquisicao: string;
          valor_residual: string;
          vida_util_meses: number;
          meses_depreciados: number;
          depreciacao_acumulada: string;
          status: string;
        }>(
          `select valor_aquisicao::text, valor_residual::text, vida_util_meses,
             meses_depreciados, depreciacao_acumulada::text, status
           from public.patrimony_assets where id=$1 and tenant_id=$2 for update`,
          [data.asset_id, data.tenant_id],
        )
      ).rows[0];
      if (!asset) throw new Error("Bem não encontrado");
      if (asset.status !== "ativo") throw new Error("Bem baixado não deprecia");
      const base = Number(asset.valor_aquisicao) - Number(asset.valor_residual);
      const cotaMensal = round2(base / asset.vida_util_meses);
      const mesesRestantes = Math.max(
        0,
        asset.vida_util_meses - asset.meses_depreciados,
      );
      const mesesAplicar = Math.min(data.meses, mesesRestantes);
      const acumuladaAtual = Number(asset.depreciacao_acumulada);
      // Cap na base; o último mês fecha exatamente na base (evita resíduo de arredondamento).
      const novaAcumulada = round2(
        Math.min(base, acumuladaAtual + cotaMensal * mesesAplicar),
      );
      const novosMeses = asset.meses_depreciados + mesesAplicar;
      await client.query(
        `update public.patrimony_assets
         set meses_depreciados=$3, depreciacao_acumulada=$4, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.asset_id, data.tenant_id, novosMeses, novaAcumulada],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "depreciate",
        resource: "patrimony_assets",
        recordId: data.asset_id,
        after: { meses: mesesAplicar, depreciacao_acumulada: novaAcumulada },
      });
      return {
        meses_depreciados: novosMeses,
        depreciacao_acumulada: novaAcumulada,
        valor_liquido: round2(Number(asset.valor_aquisicao) - novaAcumulada),
      };
    });
  });

const DisposeInput = z.object({
  tenant_id: z.string().uuid(),
  asset_id: z.string().uuid(),
  data_baixa: z.string().date(),
  motivo: z.string().trim().min(3).max(500),
  valor_alienacao: z.number().min(0).max(1_000_000_000_000).default(0),
});

// O3-11 — Baixa / alienação de bem. Apura o resultado da baixa = valor de alienação −
// valor líquido contábil (aquisição − depreciação acumulada): ganho se positivo, perda
// se negativo. Só um bem ativo pode ser baixado; a baixa é definitiva (não deprecia mais).
export const disposeAsset = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => DisposeInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "assets.manage");
    return withTransaction(async (client) => {
      const asset = (
        await client.query<{
          valor_aquisicao: string;
          depreciacao_acumulada: string;
          status: string;
        }>(
          `select valor_aquisicao::text, depreciacao_acumulada::text, status
           from public.patrimony_assets where id=$1 and tenant_id=$2 for update`,
          [data.asset_id, data.tenant_id],
        )
      ).rows[0];
      if (!asset) throw new Error("Bem não encontrado");
      if (asset.status !== "ativo") throw new Error("Bem já baixado");
      const valorLiquido = round2(
        Number(asset.valor_aquisicao) - Number(asset.depreciacao_acumulada),
      );
      // Resultado da baixa: alienação − valor líquido (ganho > 0, perda < 0).
      const resultado = round2(data.valor_alienacao - valorLiquido);
      await client.query(
        `update public.patrimony_assets
         set status='baixado', baixa_em=$3, baixa_motivo=$4, valor_alienacao=$5,
             resultado_baixa=$6, baixa_por=$7, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [
          data.asset_id,
          data.tenant_id,
          data.data_baixa,
          data.motivo,
          data.valor_alienacao,
          resultado,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "dispose",
        resource: "patrimony_assets",
        recordId: data.asset_id,
        after: {
          valor_liquido: valorLiquido,
          valor_alienacao: data.valor_alienacao,
          resultado,
        },
      });
      return { valor_liquido: valorLiquido, resultado };
    });
  });
