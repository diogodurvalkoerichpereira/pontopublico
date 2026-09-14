// Calendario de feriados do ente (O1-03d). Nacionais (tenant nulo) sao leitura;
// o ente cadastra estaduais/municipais/facultativos e os moveis por ano. Reusa as
// permissoes people.read/people.manage. Espelha fiscal-tables.functions.ts.
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

export const getHolidays = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TenantInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const holidays = await query<{
      id: string;
      tenant_id: string | null;
      name: string;
      holiday_type: string;
      year: number | null;
      month: number;
      day: number;
    }>(
      `select id, tenant_id, name, holiday_type, year, month, day
       from public.holidays
       where tenant_id=$1 or tenant_id is null
       order by month, day, coalesce(year, 0)`,
      [data.tenant_id],
    );
    return {
      holidays,
      canManage: access.permissions.includes("people.manage"),
    };
  });

const SaveHolidayInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  name: z.string().trim().min(2).max(160),
  holiday_type: z.enum(["estadual", "municipal", "facultativo"]),
  year: z.number().int().min(1900).max(2200).nullable().optional(),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
});

export const saveHoliday = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveHolidayInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.holidays
       where tenant_id=$1 and coalesce(year,0)=coalesce($2,0) and month=$3 and day=$4
         and ($5::uuid is null or id<>$5)`,
      [
        data.tenant_id,
        data.year ?? null,
        data.month,
        data.day,
        data.id ?? null,
      ],
    );
    if (duplicate)
      throw new Error("Já existe feriado nesta data para a entidade");
    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          "select * from public.holidays where id=$1 and tenant_id=$2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Feriado não encontrado");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.holidays set name=$3, holiday_type=$4, year=$5, month=$6, day=$7
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.name,
            data.holiday_type,
            data.year ?? null,
            data.month,
            data.day,
          ],
        );
      } else {
        await client.query(
          `insert into public.holidays
             (id, tenant_id, name, holiday_type, year, month, day, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            data.tenant_id,
            data.name,
            data.holiday_type,
            data.year ?? null,
            data.month,
            data.day,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "holidays",
        recordId: id,
        before: before ?? null,
        after: data,
      });
    });
    return { id };
  });
