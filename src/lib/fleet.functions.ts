// O3-05 — Frotas (Onda 3). Veículos e eventos (abastecimento/manutenção). O
// hodômetro nunca retrocede. Reusa as permissões de patrimônio (assets.*).
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

export const getFleetVehicles = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
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
  .validator((data: unknown) => SaveInput.parse(data))
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
  .validator((data: unknown) => EventInput.parse(data))
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
