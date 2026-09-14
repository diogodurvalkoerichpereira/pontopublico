// O3-12 — Ata de Registro de Preços (SRP, Onda 3, Lei 14.133 art. 82-86). De uma
// licitação homologada forma-se a ata, com itens (unidade, quantidade registrada, preço)
// e vigência de até 1 ano. As contratações consomem do saldo registrado, nunca acima.
// Reusa contracts.*.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const GetInput = z.object({ tenant_id: z.string().uuid() });

export const getPriceRegistrations = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(GetInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const registrations = await query<{
      id: string;
      numero: string;
      ano: number;
      fornecedor: string;
      vigencia_inicio: string;
      vigencia_fim: string;
      status: string;
    }>(
      `select id, numero, ano, fornecedor, vigencia_inicio::text,
         vigencia_fim::text, status
       from public.price_registrations
       where tenant_id = $1
       order by ano desc, numero desc`,
      [data.tenant_id],
    );
    const items = await query<{
      id: string;
      registration_id: string;
      descricao: string;
      unidade: string;
      quantidade_registrada: string;
      quantidade_consumida: string;
      preco_unitario: string;
    }>(
      `select i.id, i.registration_id, i.descricao, i.unidade,
         i.quantidade_registrada::text, i.quantidade_consumida::text,
         i.preco_unitario::text
       from public.price_registration_items i
       where i.tenant_id = $1
       order by i.descricao`,
      [data.tenant_id],
    );
    return {
      registrations,
      items,
      canManage: access.permissions.includes("contracts.manage"),
    };
  });

const ItemInput = z.object({
  descricao: z.string().trim().min(1).max(300),
  unidade: z.string().trim().min(1).max(20),
  quantidade_registrada: z.number().positive().max(1_000_000_000),
  preco_unitario: z.number().positive().max(1_000_000_000),
});

const CreateInput = z.object({
  tenant_id: z.string().uuid(),
  procurement_process_id: z.string().uuid(),
  numero: z.string().trim().min(1).max(40),
  ano: z.number().int().min(2000).max(2200),
  fornecedor: z.string().trim().min(2).max(200),
  vigencia_inicio: z.string().date(),
  vigencia_fim: z.string().date(),
  itens: z.array(ItemInput).min(1).max(500),
});

const UM_DIA = 86_400_000;

// Forma a ata a partir da licitação homologada. Vigência de no máximo 1 ano (art. 84).
export const createPriceRegistration = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(CreateInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    const dias =
      (Date.parse(data.vigencia_fim) - Date.parse(data.vigencia_inicio)) /
      UM_DIA;
    if (dias <= 0) throw new Error("Vigência inválida");
    if (dias > 366)
      throw new Error("A vigência da ata não pode exceder 1 ano (art. 84)");
    return withTransaction(async (client) => {
      const process = (
        await client.query<{ status: string }>(
          `select status from public.procurement_processes
           where id=$1 and tenant_id=$2 for update`,
          [data.procurement_process_id, data.tenant_id],
        )
      ).rows[0];
      if (!process) throw new Error("Licitação não encontrada");
      if (process.status !== "homologada")
        throw new Error("Só uma licitação homologada forma ata de registro");

      const id = randomUUID();
      await client.query(
        `insert into public.price_registrations
           (id, tenant_id, procurement_process_id, numero, ano, fornecedor,
            vigencia_inicio, vigencia_fim, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          data.procurement_process_id,
          data.numero,
          data.ano,
          data.fornecedor,
          data.vigencia_inicio,
          data.vigencia_fim,
          context.userId,
        ],
      );
      for (const item of data.itens) {
        await client.query(
          `insert into public.price_registration_items
             (id, tenant_id, registration_id, descricao, unidade,
              quantidade_registrada, preco_unitario)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            randomUUID(),
            data.tenant_id,
            id,
            item.descricao,
            item.unidade,
            item.quantidade_registrada,
            item.preco_unitario,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "create_price_registration",
        resource: "price_registrations",
        recordId: id,
        after: { numero: data.numero, itens: data.itens.length },
      });
      return { id, itens: data.itens.length };
    });
  });

const DrawInput = z.object({
  tenant_id: z.string().uuid(),
  item_id: z.string().uuid(),
  quantidade: z.number().positive().max(1_000_000_000),
  data_referencia: z.string().date(),
});

// Consome quantidade de um item da ata. A ata deve estar vigente (status e data), e o
// consumo nunca ultrapassa o saldo registrado (registrada − consumida).
export const drawFromPriceRegistration = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(DrawInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const item = (
        await client.query<{
          registration_id: string;
          quantidade_registrada: string;
          quantidade_consumida: string;
          preco_unitario: string;
        }>(
          `select registration_id, quantidade_registrada::text,
             quantidade_consumida::text, preco_unitario::text
           from public.price_registration_items
           where id=$1 and tenant_id=$2 for update`,
          [data.item_id, data.tenant_id],
        )
      ).rows[0];
      if (!item) throw new Error("Item da ata não encontrado");

      const ata = (
        await client.query<{
          status: string;
          vigencia_inicio: string;
          vigencia_fim: string;
        }>(
          `select status, vigencia_inicio::text, vigencia_fim::text
           from public.price_registrations
           where id=$1 and tenant_id=$2 for update`,
          [item.registration_id, data.tenant_id],
        )
      ).rows[0];
      if (ata.status !== "vigente") throw new Error("Ata não está vigente");
      if (
        data.data_referencia < ata.vigencia_inicio ||
        data.data_referencia > ata.vigencia_fim
      )
        throw new Error("Data fora da vigência da ata");

      const registrada = Number(item.quantidade_registrada);
      const consumida = Number(item.quantidade_consumida);
      const saldo = registrada - consumida;
      if (data.quantidade > saldo)
        throw new Error(
          `Consumo (${data.quantidade}) excede o saldo registrado (${saldo})`,
        );
      const novaConsumida = Number((consumida + data.quantidade).toFixed(3));
      await client.query(
        `update public.price_registration_items
         set quantidade_consumida=$3
         where id=$1 and tenant_id=$2`,
        [data.item_id, data.tenant_id, novaConsumida],
      );
      // Razao do consumo: uma linha por consumo, valorada ao preco registrado.
      const valor = Number(
        (data.quantidade * Number(item.preco_unitario)).toFixed(2),
      );
      await client.query(
        `insert into public.price_registration_draws
           (tenant_id, registration_id, item_id, quantidade, valor, data_referencia, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          data.tenant_id,
          item.registration_id,
          data.item_id,
          data.quantidade,
          valor,
          data.data_referencia,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "draw_price_registration",
        resource: "price_registration_items",
        recordId: data.item_id,
        after: { quantidade: data.quantidade, consumida: novaConsumida },
      });
      return {
        item_id: data.item_id,
        quantidade_consumida: novaConsumida,
        saldo: Number((registrada - novaConsumida).toFixed(3)),
      };
    });
  });

const CloseInput = z.object({
  tenant_id: z.string().uuid(),
  registration_id: z.string().uuid(),
  acao: z.enum(["encerrar", "cancelar"]),
  motivo: z.string().trim().max(500).optional(),
});

// Desfecho por ação. 'encerrada'/'cancelada' são terminais.
const DESFECHO: Record<string, string> = {
  encerrar: "encerrada",
  cancelar: "cancelada",
};

// O3-12b — Encerra ou cancela a ata de registro de preços (SRP, Lei 14.133 art. 82-86).
// Só uma ata **vigente** admite o encerramento (fim natural da vigência/exaustão) ou o
// cancelamento (art. 86); ambos os estados são terminais e fecham novos consumos — o
// `drawFromPriceRegistration` já recusa ata não vigente. Reusa contracts.manage.
export const closePriceRegistration = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(CloseInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const ata = (
        await client.query<{ status: string }>(
          `select status from public.price_registrations
           where id=$1 and tenant_id=$2 for update`,
          [data.registration_id, data.tenant_id],
        )
      ).rows[0];
      if (!ata) throw new Error("Ata não encontrada");
      if (ata.status !== "vigente")
        throw new Error(`Ata '${ata.status}' não admite a ação`);
      const novo = DESFECHO[data.acao];
      await client.query(
        `update public.price_registrations set status=$3, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.registration_id, data.tenant_id, novo],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: `price_registration_${data.acao}`,
        resource: "price_registrations",
        recordId: data.registration_id,
        after: { status: novo, motivo: data.motivo ?? null },
      });
      return { id: data.registration_id, status: novo };
    });
  });

const SummaryInput = z.object({ tenant_id: z.string().uuid() });

// O3-12c — Resumo do registro de preços. Consolida a contagem de atas por situação e, das
// atas **vigentes**, o valor financeiro registrado (Σ quantidade_registrada × preço), o
// já consumido (Σ quantidade_consumida × preço) e o saldo a consumir (registrado −
// consumido) — o comprometimento vivo do SRP. Read-only, reusa contracts.read.
export const getPriceRegistrationSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SummaryInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const status = (
      await query<{
        vigentes: string;
        encerradas: string;
        canceladas: string;
      }>(
        `select
           count(*) filter (where status='vigente')::text as vigentes,
           count(*) filter (where status='encerrada')::text as encerradas,
           count(*) filter (where status='cancelada')::text as canceladas
         from public.price_registrations
         where tenant_id = $1`,
        [data.tenant_id],
      )
    )[0];
    const fin = (
      await query<{ registrado: string; consumido: string }>(
        `select
           coalesce(sum(i.quantidade_registrada * i.preco_unitario)
             filter (where r.status='vigente'),0)::text as registrado,
           coalesce(sum(i.quantidade_consumida * i.preco_unitario)
             filter (where r.status='vigente'),0)::text as consumido
         from public.price_registration_items i
         join public.price_registrations r on r.id = i.registration_id
         where i.tenant_id = $1`,
        [data.tenant_id],
      )
    )[0];
    const valorRegistrado = Number(Number(fin.registrado).toFixed(2));
    const valorConsumido = Number(Number(fin.consumido).toFixed(2));
    return {
      porStatus: {
        vigente: Number(status.vigentes),
        encerrada: Number(status.encerradas),
        cancelada: Number(status.canceladas),
      },
      valorRegistrado,
      valorConsumido,
      saldoAConsumir: Number((valorRegistrado - valorConsumido).toFixed(2)),
    };
  });

const DrawsInput = z.object({
  tenant_id: z.string().uuid(),
  registration_id: z.string().uuid(),
});

// O3-12d — Historico (razao) dos consumos de uma ata. Lista cada consumo
// (O3-12) em ordem cronologica, com o item, a quantidade e o valor, e consolida
// o total consumido — a trilha auditavel do uso da ata (SRP), isolada por ata.
// Read-only, reusa contracts.read.
export const getPriceRegistrationDraws = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(DrawsInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const draws = await query<{
      id: string;
      item_id: string;
      descricao: string;
      unidade: string;
      quantidade: string;
      valor: string;
      data_referencia: string;
    }>(
      `select d.id, d.item_id, i.descricao, i.unidade,
         d.quantidade::text, d.valor::text, d.data_referencia::text
       from public.price_registration_draws d
       join public.price_registration_items i on i.id = d.item_id
       where d.tenant_id = $1 and d.registration_id = $2
       order by d.data_referencia, d.created_at, d.id`,
      [data.tenant_id, data.registration_id],
    );
    const totalConsumido = Number(
      draws.reduce((s, d) => s + Number(d.valor), 0).toFixed(2),
    );
    return {
      draws: draws.map((d) => ({
        ...d,
        quantidade: Number(d.quantidade),
        valor: Number(d.valor),
      })),
      totalConsumido,
    };
  });

const ExpiringInput = z.object({
  tenant_id: z.string().uuid(),
  data_referencia: z.string().date(),
  dias_alerta: z.number().int().min(1).max(365).default(30),
});

// O3-12e — Alerta de vigência das atas de registro de preços (Lei 14.133 art. 84). Lista as
// atas ainda com status 'vigente' que já **venceram** (vigencia_fim < referência → não
// admitem mais consumo, mas seguem 'vigente' e deveriam ser encerradas) ou que **vencem**
// dentro da janela de alerta (padrão 30 dias). `dias_para_vencer` negativo = vencida; conta
// vencidas × a vencer. Read-only, reusa contracts.read.
export const getExpiringPriceRegistrations = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(ExpiringInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const registrations = await query<{
      id: string;
      numero: string;
      ano: number;
      fornecedor: string;
      vigencia_fim: string;
      dias_para_vencer: number;
    }>(
      `select id, numero, ano, fornecedor, vigencia_fim::text,
         (vigencia_fim - $2::date)::int as dias_para_vencer
       from public.price_registrations
       where tenant_id = $1 and status = 'vigente'
         and vigencia_fim <= ($2::date + ($3 || ' days')::interval)
       order by vigencia_fim, numero`,
      [data.tenant_id, data.data_referencia, data.dias_alerta],
    );
    const vencidas = registrations.filter((r) => r.dias_para_vencer < 0).length;
    return {
      registrations,
      dias: data.dias_alerta,
      vencidas,
      aVencer: registrations.length - vencidas,
    };
  });
