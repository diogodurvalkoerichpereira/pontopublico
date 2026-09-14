// O3-05 — Frotas (Onda 3). Veículos e eventos (abastecimento/manutenção). O
// hodômetro nunca retrocede. Reusa as permissões de patrimônio (assets.*).
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

export const getFleetVehicles = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TenantInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "assets.read");
    const vehicles = await query<{
      id: string;
      placa: string;
      modelo: string;
      ano: number;
      odometro_atual: string;
      status: string;
    }>(
      `select id, placa, modelo, ano, odometro_atual::text, status
       from public.fleet_vehicles where tenant_id = $1 order by placa`,
      [data.tenant_id],
    );
    return {
      vehicles,
      canManage: access.permissions.includes("assets.manage"),
    };
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  placa: z.string().trim().min(5).max(10),
  modelo: z.string().trim().min(1).max(120),
  ano: z.number().int().min(1950).max(2200),
  status: z.enum(["ativo", "manutencao", "baixado"]).default("ativo"),
});

export const saveFleetVehicle = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "assets.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.fleet_vehicles
       where tenant_id=$1 and upper(placa)=upper($2)
         and ($3::uuid is null or id<>$3)`,
      [data.tenant_id, data.placa, data.id ?? null],
    );
    if (duplicate) throw new Error("Placa já cadastrada");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.fleet_vehicles set placa=$3, modelo=$4, ano=$5,
             status=$6, updated_at=now() where id=$1 and tenant_id=$2`,
          [id, data.tenant_id, data.placa, data.modelo, data.ano, data.status],
        );
      } else {
        await client.query(
          `insert into public.fleet_vehicles
             (id, tenant_id, placa, modelo, ano, status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            data.tenant_id,
            data.placa,
            data.modelo,
            data.ano,
            data.status,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "fleet_vehicles",
        recordId: id,
        after: data,
      });
    });
    return { id };
  });

const EventInput = z.object({
  tenant_id: z.string().uuid(),
  vehicle_id: z.string().uuid(),
  tipo: z.enum(["abastecimento", "manutencao"]),
  data_evento: z.string().date(),
  odometro: z.number().min(0).max(9_999_999),
  litros: z.number().positive().max(100000).nullable().optional(),
  valor: z.number().min(0).max(1_000_000_000),
  historico: z.string().trim().min(3).max(500),
});

// Registra um evento; o hodômetro do veículo nunca retrocede.
export const recordFleetEvent = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(EventInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "assets.manage");
    return withTransaction(async (client) => {
      const vehicle = (
        await client.query<{ odometro_atual: string; status: string }>(
          `select odometro_atual::text, status from public.fleet_vehicles
           where id=$1 and tenant_id=$2 for update`,
          [data.vehicle_id, data.tenant_id],
        )
      ).rows[0];
      if (!vehicle) throw new Error("Veículo não encontrado");
      if (vehicle.status === "baixado")
        throw new Error("Veículo baixado não registra eventos");
      if (data.odometro < Number(vehicle.odometro_atual))
        throw new Error(
          `Hodômetro (${data.odometro}) não pode retroceder (atual ${vehicle.odometro_atual})`,
        );
      const id = randomUUID();
      await client.query(
        `insert into public.fleet_events
           (id, tenant_id, vehicle_id, tipo, data_evento, odometro, litros, valor,
            historico, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          data.tenant_id,
          data.vehicle_id,
          data.tipo,
          data.data_evento,
          data.odometro,
          data.litros ?? null,
          data.valor,
          data.historico,
          context.userId,
        ],
      );
      await client.query(
        `update public.fleet_vehicles set odometro_atual=$3, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.vehicle_id, data.tenant_id, data.odometro],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.tipo,
        resource: "fleet_events",
        recordId: id,
        after: { odometro: data.odometro, valor: data.valor },
      });
      return { id, odometro_atual: data.odometro };
    });
  });

const round2 = (n: number) => Number(n.toFixed(2));

const ConsumptionInput = z.object({
  tenant_id: z.string().uuid(),
  vehicle_id: z.string().uuid(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

// O3-05b — Consumo e custo por veículo (controle de frota). O consumo médio (km/l) segue o
// método "de tanque a tanque": os litros do PRIMEIRO abastecimento da janela enchem o
// tanque no odômetro inicial e não se sabe a quilometragem que os gastou, então só os
// litros dos abastecimentos seguintes são atribuídos à distância percorrida entre o
// primeiro e o último abastecimento. Custo por km usa o gasto com combustível JÁ consumido
// (exclui o primeiro abastecimento), coerente com o consumo. Precisa de ≥2 abastecimentos;
// senão consumo/custo ficam nulos. Read-only, reusa assets.read.
export const getFleetConsumption = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(ConsumptionInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "assets.read");
    const vehicle = await queryOne<{ id: string }>(
      "select id from public.fleet_vehicles where id=$1 and tenant_id=$2",
      [data.vehicle_id, data.tenant_id],
    );
    if (!vehicle) throw new Error("Veículo não encontrado");
    const fuel = await query<{
      odometro: string;
      litros: string | null;
      valor: string;
    }>(
      `select odometro::text, litros::text, valor::text
       from public.fleet_events
       where tenant_id=$1 and vehicle_id=$2 and tipo='abastecimento'
         and ($3::date is null or data_evento >= $3)
         and ($4::date is null or data_evento <= $4)
       order by odometro, data_evento`,
      [data.tenant_id, data.vehicle_id, data.from ?? null, data.to ?? null],
    );
    const manut = await queryOne<{ s: string }>(
      `select coalesce(sum(valor),0)::text as s from public.fleet_events
       where tenant_id=$1 and vehicle_id=$2 and tipo='manutencao'
         and ($3::date is null or data_evento >= $3)
         and ($4::date is null or data_evento <= $4)`,
      [data.tenant_id, data.vehicle_id, data.from ?? null, data.to ?? null],
    );

    const litrosAbastecidos = round2(
      fuel.reduce((s, f) => s + Number(f.litros ?? 0), 0),
    );
    const gastoCombustivel = round2(
      fuel.reduce((s, f) => s + Number(f.valor), 0),
    );
    const gastoManutencao = Number(manut?.s ?? 0);

    let kmPercorridos: number | null = null;
    let consumoMedio: number | null = null;
    let custoPorKm: number | null = null;
    if (fuel.length >= 2) {
      const primeiro = fuel[0];
      const ultimo = fuel[fuel.length - 1];
      kmPercorridos = round2(
        Number(ultimo.odometro) - Number(primeiro.odometro),
      );
      // Só os litros/custo APÓS o primeiro abastecimento foram gastos no percurso.
      const litrosConsumidos = round2(
        litrosAbastecidos - Number(primeiro.litros ?? 0),
      );
      const gastoConsumido = round2(gastoCombustivel - Number(primeiro.valor));
      if (kmPercorridos > 0 && litrosConsumidos > 0) {
        consumoMedio = round2(kmPercorridos / litrosConsumidos);
        custoPorKm = round2(gastoConsumido / kmPercorridos);
      }
    }
    return {
      abastecimentos: fuel.length,
      litrosAbastecidos,
      gastoCombustivel,
      gastoManutencao,
      kmPercorridos,
      consumoMedio,
      custoPorKm,
    };
  });

const CostSummaryInput = z.object({
  tenant_id: z.string().uuid(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

// O3-05c — Custo total da frota no período, por veículo. Consolida o gasto com
// abastecimento e com manutenção de cada veículo no intervalo, com o total por
// veículo e os totais do ente — a visão gerencial de custo da frota (complementa o
// consumo por veículo do O3-05b). Veículo sem evento no período fica zerado (ainda
// listado). Read-only, reusa assets.read.
export const getFleetCostSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(CostSummaryInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "assets.read");
    const rows = await query<{
      id: string;
      placa: string;
      modelo: string;
      combustivel: string;
      manutencao: string;
    }>(
      `select v.id, v.placa, v.modelo,
         coalesce(sum(e.valor) filter (where e.tipo='abastecimento'),0)::text as combustivel,
         coalesce(sum(e.valor) filter (where e.tipo='manutencao'),0)::text as manutencao
       from public.fleet_vehicles v
       left join public.fleet_events e
         on e.vehicle_id = v.id and e.tenant_id = v.tenant_id
         and ($2::date is null or e.data_evento >= $2)
         and ($3::date is null or e.data_evento <= $3)
       where v.tenant_id = $1
       group by v.id, v.placa, v.modelo
       order by v.placa`,
      [data.tenant_id, data.from ?? null, data.to ?? null],
    );
    const veiculos = rows.map((r) => {
      const combustivel = Number(r.combustivel);
      const manutencao = Number(r.manutencao);
      return {
        id: r.id,
        placa: r.placa,
        modelo: r.modelo,
        combustivel: round2(combustivel),
        manutencao: round2(manutencao),
        total: round2(combustivel + manutencao),
      };
    });
    const totais = veiculos.reduce(
      (acc, v) => ({
        combustivel: round2(acc.combustivel + v.combustivel),
        manutencao: round2(acc.manutencao + v.manutencao),
        total: round2(acc.total + v.total),
      }),
      { combustivel: 0, manutencao: 0, total: 0 },
    );
    return { veiculos, totais };
  });
