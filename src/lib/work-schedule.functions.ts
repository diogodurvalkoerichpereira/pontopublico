// O1-03f — Escala semanal customizada por vinculo (jornada diaria). Guarda os
// minutos previstos de cada dia da semana (domingo..sabado) por vinculo, que a
// apuracao (time-clock.functions) consome. Sem escala, a apuracao cai no padrao
// por `weekly_hours` (seg-sex). Reusa people.read / people.manage.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
import { defaultExpectedByWeekday } from "./time-mirror";

const TenantInput = z.object({ tenant_id: z.string().uuid() });

// [domingo, segunda, ..., sabado] em minutos.
const WEEKDAY_COLUMNS = [
  "minutes_sun",
  "minutes_mon",
  "minutes_tue",
  "minutes_wed",
  "minutes_thu",
  "minutes_fri",
  "minutes_sat",
] as const;

type ScheduleRow = Record<(typeof WEEKDAY_COLUMNS)[number], number>;

function rowToMinutes(row: ScheduleRow): number[] {
  return WEEKDAY_COLUMNS.map((col) => Number(row[col]));
}

/** Vinculos ativos do ente com a escala semanal EFETIVA (custom quando houver,
 *  senao o padrao por weekly_hours), para edicao. Guard people.read. */
export const getEmploymentWeeklySchedules = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const links = await query<{
      id: string;
      registration_number: string | null;
      full_name: string;
      weekly_hours: number | null;
    }>(
      `select l.id, l.registration_number, p.full_name, l.weekly_hours
       from public.employment_links l
       join public.persons p on p.id = l.person_id
       where l.tenant_id = $1 and l.status = 'ativo'
       order by p.full_name`,
      [data.tenant_id],
    );
    const rows = await query<ScheduleRow & { employment_link_id: string }>(
      `select employment_link_id, minutes_sun, minutes_mon, minutes_tue,
              minutes_wed, minutes_thu, minutes_fri, minutes_sat
       from public.employment_weekly_schedules
       where tenant_id = $1`,
      [data.tenant_id],
    );
    const byLink = new Map(rows.map((r) => [r.employment_link_id, r]));
    return {
      canManage: access.permissions.includes("people.manage"),
      servidores: links.map((link) => {
        const row = byLink.get(link.id);
        return {
          employment_link_id: link.id,
          registration_number: link.registration_number,
          full_name: link.full_name,
          weekly_hours: Number(link.weekly_hours ?? 0),
          custom: Boolean(row),
          // Sempre 7 posicoes (dom..sab), efetivas.
          minutes: row
            ? rowToMinutes(row)
            : defaultExpectedByWeekday(Number(link.weekly_hours ?? 0)),
        };
      }),
    };
  });

const SaveInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  // [domingo..sabado], minutos previstos por dia.
  minutes: z.array(z.number().int().min(0).max(1440)).length(7),
});

/** Salva (upsert) a escala semanal customizada de um vinculo. Guard people.manage. */
export const saveEmploymentWeeklySchedule = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.manage");
    return withTransaction(async (client) => {
      const link = (
        await client.query<{ id: string }>(
          "select id from public.employment_links where id=$1 and tenant_id=$2",
          [data.employment_link_id, data.tenant_id],
        )
      ).rows[0];
      if (!link) throw new Error("Vínculo inválido para esta entidade");
      await client.query(
        `insert into public.employment_weekly_schedules
           (tenant_id, employment_link_id, minutes_sun, minutes_mon, minutes_tue,
            minutes_wed, minutes_thu, minutes_fri, minutes_sat, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (tenant_id, employment_link_id) do update
           set minutes_sun = excluded.minutes_sun,
               minutes_mon = excluded.minutes_mon,
               minutes_tue = excluded.minutes_tue,
               minutes_wed = excluded.minutes_wed,
               minutes_thu = excluded.minutes_thu,
               minutes_fri = excluded.minutes_fri,
               minutes_sat = excluded.minutes_sat,
               updated_at = now()`,
        [
          data.tenant_id,
          data.employment_link_id,
          ...data.minutes,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "save_weekly_schedule",
        resource: "employment_weekly_schedules",
        recordId: data.employment_link_id,
        after: { minutes: data.minutes },
      });
      return { employment_link_id: data.employment_link_id };
    });
  });
