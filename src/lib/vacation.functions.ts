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

// O1-05b — ferias tributadas pela via do ciclo. O agendamento emite so o bruto
// (base + 1/3). Reter INSS/IRRF isolados aqui erraria: a remuneracao de ferias
// integra o salario-de-contribuicao da competencia (teto unico do INSS). Entao,
// em vez de tributar a parte, deposita-se a remuneracao em
// payroll_monthly_variables (como o ponto no O1-04b) e o CICLO tributa a base
// combinada por incidencias (ADR 0003). O agendamento continua o documento bruto;
// o liquido nasce no ciclo. Idempotente: re-depositar substitui a competencia.
const DepositVacationInput = z.object({
  tenant_id: z.string().uuid(),
  schedule_id: z.string().uuid(),
  // Rubrica da remuneracao de ferias (integra a base — deve ter incidencia inss/irrf).
  vacation_rubric_id: z.string().uuid(),
  // Rubrica do 1/3 constitucional; se omitida, base + 1/3 vao juntos na de ferias.
  bonus_rubric_id: z.string().uuid().optional(),
  // Competencia do gozo; default: mes de inicio das ferias.
  reference_month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});
export const depositVacationToPayroll = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => DepositVacationInput.parse(v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "payroll.assignments.manage");
    const schedule = (
      await query<{
        employment_link_id: string;
        base_amount: string;
        bonus_amount: string;
        start_date: string;
      }>(
        `select period.employment_link_id, s.base_amount, s.bonus_amount, s.start_date::text
         from public.vacation_schedules s
         join public.vacation_accrual_periods period on period.id=s.accrual_period_id
         where s.id=$1 and s.tenant_id=$2`,
        [data.schedule_id, data.tenant_id],
      )
    )[0];
    if (!schedule) throw new Error("Agendamento de férias inválido");

    const rubricIds = [
      data.vacation_rubric_id,
      ...(data.bonus_rubric_id ? [data.bonus_rubric_id] : []),
    ];
    const found = await query<{ id: string }>(
      "select id from public.payroll_rubrics where tenant_id=$1 and id=any($2::uuid[])",
      [data.tenant_id, rubricIds],
    );
    if (found.length !== new Set(rubricIds).size)
      throw new Error("Rubrica inválida para esta entidade");

    const referenceDate = `${data.reference_month ?? schedule.start_date.slice(0, 7)}-01`;
    const base = Number(schedule.base_amount);
    const bonus = Number(schedule.bonus_amount);
    // Sem rubrica de abono, base + 1/3 vao juntos na rubrica de ferias.
    const deposits: Array<{ rubricId: string; amount: number }> = [
      {
        rubricId: data.vacation_rubric_id,
        amount: data.bonus_rubric_id ? base : Number((base + bonus).toFixed(2)),
      },
    ];
    if (data.bonus_rubric_id)
      deposits.push({ rubricId: data.bonus_rubric_id, amount: bonus });

    await withTransaction(async (client) => {
      for (const deposit of deposits) {
        // Re-depositar substitui a competencia (chave unica trata source_batch_id
        // nulo como distinto — apaga-e-insere).
        await client.query(
          `delete from public.payroll_monthly_variables
           where tenant_id=$1 and employment_link_id=$2 and rubric_id=$3
             and reference_month=$4 and source_batch_id is null`,
          [
            data.tenant_id,
            schedule.employment_link_id,
            deposit.rubricId,
            referenceDate,
          ],
        );
        if (deposit.amount > 0)
          await client.query(
            `insert into public.payroll_monthly_variables
               (tenant_id, employment_link_id, rubric_id, reference_month, amount,
                installment_number, installments_total)
             values ($1,$2,$3,$4,$5,1,1)`,
            [
              data.tenant_id,
              schedule.employment_link_id,
              deposit.rubricId,
              referenceDate,
              deposit.amount,
            ],
          );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "deposit",
        resource: "payroll_monthly_variables",
        recordId: schedule.employment_link_id,
        before: null,
        after: {
          reference_month: referenceDate,
          schedule_id: data.schedule_id,
          base,
          bonus,
        },
      });
    });
    return {
      reference_month: referenceDate,
      employment_link_id: schedule.employment_link_id,
      base,
      bonus,
    };
  });

const DeadlineInput = z.object({
  tenant_id: z.string().uuid(),
  data_referencia: z.string().date(),
  dias_alerta: z.number().int().min(1).max(365).default(60),
});

// O1-05c — Alerta de limite do período concessivo de férias (CLT art. 134/137). Um período
// aquisitivo ainda devido (dias não gozados) precisa ser concedido até o `concession_deadline`;
// passar dessa data obriga o pagamento **em dobro** (art. 137) — passivo trabalhista. Lista
// os períodos com saldo (`taken_days < entitled_days`) e obrigação viva
// (disponivel/programado/em_gozo) cujo limite já venceu (`< data_referencia`) ou vence dentro
// da janela de alerta, com quantos dias faltam (negativo = vencido). Read-only, reusa
// vacation.read.
export const getVacationDeadlineAlerts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => DeadlineInput.parse(v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "vacation.read");
    const alerts = await query<{
      id: string;
      full_name: string;
      registration_number: string;
      accrual_start: string;
      accrual_end: string;
      concession_deadline: string;
      entitled_days: number;
      taken_days: number;
      dias_para_limite: number;
      vencido: boolean;
    }>(
      `select ap.id, p.full_name, l.registration_number,
         ap.accrual_start::text, ap.accrual_end::text, ap.concession_deadline::text,
         ap.entitled_days, ap.taken_days,
         (ap.concession_deadline - $2::date)::int as dias_para_limite,
         (ap.concession_deadline < $2::date) as vencido
       from public.vacation_accrual_periods ap
       join public.employment_links l on l.id = ap.employment_link_id
       join public.persons p on p.id = l.person_id
       where ap.tenant_id = $1
         and ap.status in ('disponivel','programado','em_gozo')
         and ap.taken_days < ap.entitled_days
         and ap.concession_deadline <= ($2::date + ($3 || ' days')::interval)
       order by ap.concession_deadline`,
      [data.tenant_id, data.data_referencia, data.dias_alerta],
    );
    const vencidos = alerts.filter((r) => r.vencido).length;
    return {
      alerts,
      vencidos,
      aVencer: alerts.length - vencidos,
      dias: data.dias_alerta,
    };
  });
