import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
const Tenant = z.object({ tenant_id: z.string().uuid() });
export const getVacationWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => Tenant.parse(v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "vacation.read");
    const [links, periods, schedules] = await Promise.all([
      query<any>(
        `select l.id,l.registration_number,l.base_salary,l.admission_date::text,p.full_name from public.employment_links l join public.persons p on p.id=l.person_id where l.tenant_id=$1 and l.status<>'desligado' order by p.full_name`,
        [data.tenant_id],
      ),
      query<any>(
        `select a.*,p.full_name,l.registration_number from public.vacation_accrual_periods a join public.employment_links l on l.id=a.employment_link_id join public.persons p on p.id=l.person_id where a.tenant_id=$1 order by a.accrual_start desc`,
        [data.tenant_id],
      ),
      query<any>(
        `select s.* from public.vacation_schedules s where s.tenant_id=$1 order by s.start_date`,
        [data.tenant_id],
      ),
    ]);
    return {
      links,
      periods,
      schedules,
      canManage: a.permissions.includes("vacation.manage"),
    };
  });
export const generateVacationPeriod = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        employment_link_id: z.string().uuid(),
        accrual_start: z.string().date(),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "vacation.manage");
    return withTransaction(async (c) => {
      let p = (
        await c.query<any>(
          `select id,entitlement_days from public.vacation_policies where tenant_id=$1 and effective_from<=$2 order by effective_from desc limit 1`,
          [data.tenant_id, data.accrual_start],
        )
      ).rows[0];
      if (!p) {
        p = { id: randomUUID(), entitlement_days: 30 };
        await c.query(
          `insert into public.vacation_policies(id,tenant_id,name,effective_from)values($1,$2,'Regra padrão',$3)`,
          [p.id, data.tenant_id, data.accrual_start],
        );
      }
      const start = new Date(data.accrual_start + "T00:00:00Z"),
        end = new Date(start);
      end.setUTCFullYear(end.getUTCFullYear() + 1);
      end.setUTCDate(end.getUTCDate() - 1);
      const deadline = new Date(end);
      deadline.setUTCFullYear(deadline.getUTCFullYear() + 1);
      const id = randomUUID();
      await c.query(
        `insert into public.vacation_accrual_periods(id,tenant_id,employment_link_id,policy_id,accrual_start,accrual_end,concession_deadline,entitled_days,status)values($1,$2,$3,$4,$5,$6,$7,$8,'disponivel')`,
        [
          id,
          data.tenant_id,
          data.employment_link_id,
          p.id,
          data.accrual_start,
          end.toISOString().slice(0, 10),
          deadline.toISOString().slice(0, 10),
          p.entitlement_days,
        ],
      );
      return { id };
    });
  });
export const scheduleVacation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        accrual_period_id: z.string().uuid(),
        start_date: z.string().date(),
        days: z.number().int().positive().max(30),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "vacation.manage");
    const p = (
      await query<any>(
        `select a.*,l.base_salary,policy.bonus_rate from public.vacation_accrual_periods a join public.employment_links l on l.id=a.employment_link_id join public.vacation_policies policy on policy.id=a.policy_id where a.id=$1 and a.tenant_id=$2`,
        [data.accrual_period_id, data.tenant_id],
      )
    )[0];
    if (!p) throw new Error("Período inválido");
    const start = new Date(data.start_date + "T00:00:00Z"),
      end = new Date(start);
    end.setUTCDate(end.getUTCDate() + data.days - 1);
    const pay = new Date(start);
    pay.setUTCDate(pay.getUTCDate() - 2);
    const base = +((Number(p.base_salary) / 30) * data.days).toFixed(2),
      bonus = +(base * Number(p.bonus_rate)).toFixed(2);
    const id = randomUUID();
    await query(
      `insert into public.vacation_schedules(id,tenant_id,accrual_period_id,start_date,end_date,days,base_amount,bonus_amount,total_amount,payment_date,memory,created_by)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [
        id,
        data.tenant_id,
        data.accrual_period_id,
        data.start_date,
        end.toISOString().slice(0, 10),
        data.days,
        base,
        bonus,
        base + bonus,
        pay.toISOString().slice(0, 10),
        JSON.stringify({
          salary: p.base_salary,
          days: data.days,
          bonus_rate: p.bonus_rate,
        }),
        context.userId,
      ],
    );
    return { id, total: base + bonus };
  });
