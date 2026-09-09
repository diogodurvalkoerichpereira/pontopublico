// Registro e verificacao das marcacoes de ponto encadeadas (O1-03a). A marcacao e
// append-only (o banco recusa update/delete): correcao se faz por nova marcacao.
// NSR sequencial e encadeamento gerados sob trava da linha-contador do ente.
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
import { hashPunch, GENESIS_HASH } from "./time-clock.server";
import {
  buildTimeMirror,
  apurarJornada,
  defaultExpectedByWeekday,
  type MirrorPunch,
  type HolidayRule,
} from "./time-mirror";

const RecordInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  punch_time: z.string().datetime().optional(),
  source: z.enum(["manual", "app", "rep"]).default("manual"),
});

export const recordTimeClockPunch = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => RecordInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.manage");
    const punchTime = (
      data.punch_time ? new Date(data.punch_time) : new Date()
    ).toISOString();
    return withTransaction(async (client) => {
      const link = await client.query(
        "select id from public.employment_links where id=$1 and tenant_id=$2",
        [data.employment_link_id, data.tenant_id],
      );
      if (!link.rows.length)
        throw new Error("Vínculo inválido para esta entidade");
      // Cria (se preciso) e TRAVA a linha-contador do ente: serializa NSR/cadeia.
      await client.query(
        "insert into public.time_clock_counters (tenant_id) values ($1) on conflict (tenant_id) do nothing",
        [data.tenant_id],
      );
      const counter = (
        await client.query(
          "select last_nsr, last_hash from public.time_clock_counters where tenant_id=$1 for update",
          [data.tenant_id],
        )
      ).rows[0];
      const nsr = Number(counter.last_nsr) + 1;
      const previousHash = counter.last_hash;
      const recordHash = hashPunch({
        tenantId: data.tenant_id,
        employmentLinkId: data.employment_link_id,
        nsr,
        punchTime,
        source: data.source,
        previousHash,
      });
      const id = randomUUID();
      await client.query(
        `insert into public.time_clock_punches
           (id, tenant_id, employment_link_id, nsr, punch_time, source,
            previous_hash, record_hash, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          data.employment_link_id,
          nsr,
          punchTime,
          data.source,
          previousHash,
          recordHash,
          context.userId,
        ],
      );
      await client.query(
        "update public.time_clock_counters set last_nsr=$2, last_hash=$3, updated_at=now() where tenant_id=$1",
        [data.tenant_id, nsr, recordHash],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "register",
        resource: "time_clock_punches",
        recordId: id,
        before: null,
        after: {
          employment_link_id: data.employment_link_id,
          nsr,
          punch_time: punchTime,
          record_hash: recordHash,
        },
      });
      return { id, nsr, recordHash };
    });
  });

const ListInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const getTimeClockPunches = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ListInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const values: unknown[] = [data.tenant_id];
    let filter = "";
    if (data.employment_link_id) {
      values.push(data.employment_link_id);
      filter += ` and employment_link_id=$${values.length}`;
    }
    if (data.from) {
      values.push(data.from);
      filter += ` and punch_time>=$${values.length}`;
    }
    if (data.to) {
      values.push(data.to);
      filter += ` and punch_time<=$${values.length}`;
    }
    return query<{
      id: string;
      employment_link_id: string;
      nsr: number;
      punch_time: string;
      source: string;
      record_hash: string;
    }>(
      `select id, employment_link_id, nsr, punch_time, source, record_hash
       from public.time_clock_punches
       where tenant_id=$1${filter}
       order by nsr`,
      values,
    );
  });

const VerifyInput = z.object({ tenant_id: z.string().uuid() });

export const verifyTimeClockChain = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => VerifyInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const rows = await query<{
      employment_link_id: string;
      nsr: number;
      punch_time: string;
      source: string;
      previous_hash: string;
      record_hash: string;
    }>(
      `select employment_link_id, nsr, punch_time, source, previous_hash, record_hash
       from public.time_clock_punches where tenant_id=$1 order by nsr`,
      [data.tenant_id],
    );
    let expectedPrev = GENESIS_HASH;
    for (const row of rows) {
      const punchTime = new Date(row.punch_time).toISOString();
      const recomputed = hashPunch({
        tenantId: data.tenant_id,
        employmentLinkId: row.employment_link_id,
        nsr: Number(row.nsr),
        punchTime,
        source: row.source,
        previousHash: row.previous_hash,
      });
      if (row.previous_hash !== expectedPrev)
        return {
          valid: false,
          brokenAtNsr: Number(row.nsr),
          reason: "encadeamento",
        };
      if (recomputed !== row.record_hash)
        return { valid: false, brokenAtNsr: Number(row.nsr), reason: "hash" };
      expectedPrev = row.record_hash;
    }
    return { valid: true, count: rows.length };
  });

const MirrorInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  time_zone: z.string().max(64).optional(),
});

/** Espelho de ponto: jornada apurada por dia (pareamento posicional das marcas). */
export const getTimeMirror = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => MirrorInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const values: unknown[] = [data.tenant_id, data.employment_link_id];
    let filter = "";
    if (data.from) {
      values.push(data.from);
      filter += ` and punch_time>=$${values.length}`;
    }
    if (data.to) {
      values.push(data.to);
      filter += ` and punch_time<=$${values.length}`;
    }
    const rows = await query<{
      nsr: number;
      punch_time: string;
      source: string;
      record_hash: string;
    }>(
      `select nsr, punch_time, source, record_hash
       from public.time_clock_punches
       where tenant_id=$1 and employment_link_id=$2${filter}
       order by nsr`,
      values,
    );
    const punches: MirrorPunch[] = rows.map((row) => ({
      nsr: Number(row.nsr),
      punchTime: new Date(row.punch_time).toISOString(),
      recordHash: row.record_hash,
      source: row.source,
    }));
    // Feriados do ente + nacionais, marcados no espelho (O1-03d).
    const holidays = await query<HolidayRule>(
      `select year, month, day, name from public.holidays
       where tenant_id=$1 or tenant_id is null`,
      [data.tenant_id],
    );
    return buildTimeMirror(punches, data.time_zone, holidays);
  });

const ReceiptInput = z.object({
  tenant_id: z.string().uuid(),
  punch_id: z.string().uuid(),
});

/** Comprovante interno de uma marcacao: NSR + hash como codigo verificador, com o
 *  servidor identificado. Base interna — o comprovante oficial da Portaria 671 e
 *  o O1-03b (exige homologacao). CPF integral so com people.sensitive.read. */
export const getPunchReceipt = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ReceiptInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const row = await queryOne<{
      nsr: number;
      punch_time: string;
      source: string;
      record_hash: string;
      registration_number: string;
      unit_name: string | null;
      full_name: string;
      cpf: string | null;
    }>(
      `select tcp.nsr, tcp.punch_time, tcp.source, tcp.record_hash,
         el.registration_number, u.nome as unit_name, pe.full_name, pe.cpf
       from public.time_clock_punches tcp
       join public.employment_links el on el.id = tcp.employment_link_id
       join public.persons pe on pe.id = el.person_id
       left join public.unidades u on u.id = el.unit_id and u.tenant_id = el.tenant_id
       where tcp.id=$1 and tcp.tenant_id=$2`,
      [data.punch_id, data.tenant_id],
    );
    if (!row) throw new Error("Marcação não encontrada");
    const canSensitive = access.permissions.includes("people.sensitive.read");
    const digits = (row.cpf ?? "").replace(/\D/g, "");
    const cpf = !digits
      ? null
      : canSensitive
        ? row.cpf
        : `***.***.***-${digits.slice(-2)}`;
    return {
      nsr: Number(row.nsr),
      punch_time: new Date(row.punch_time).toISOString(),
      source: row.source,
      record_hash: row.record_hash,
      // Codigo verificador curto derivado do hash da marcacao (imutavel).
      verification_code: row.record_hash.slice(0, 12).toUpperCase(),
      employee: {
        registration_number: row.registration_number,
        full_name: row.full_name,
        cpf,
        unit_name: row.unit_name,
      },
    };
  });

const ApuracaoInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  time_zone: z.string().max(64).optional(),
  tolerance_minutes: z.number().int().min(0).max(60).default(10),
});

// Carrega o vinculo, as marcacoes do periodo e os feriados, e apura a jornada.
// Compartilhado por getTimeApuracao (leitura) e depositTimeApuracao (folha).
async function loadApuracao(
  tenantId: string,
  employmentLinkId: string,
  from: string,
  to: string,
  timeZone: string | undefined,
  toleranceMinutes: number,
) {
  const link = await queryOne<{
    weekly_hours: number | null;
    base_salary: number | null;
  }>(
    "select weekly_hours, base_salary from public.employment_links where id=$1 and tenant_id=$2",
    [employmentLinkId, tenantId],
  );
  if (!link) throw new Error("Vínculo inválido para esta entidade");
  const rows = await query<{
    nsr: number;
    punch_time: string;
    source: string;
    record_hash: string;
  }>(
    `select nsr, punch_time, source, record_hash
     from public.time_clock_punches
     where tenant_id=$1 and employment_link_id=$2
       and punch_time>=$3 and punch_time<=$4
     order by nsr`,
    [tenantId, employmentLinkId, from, to],
  );
  const punches: MirrorPunch[] = rows.map((row) => ({
    nsr: Number(row.nsr),
    punchTime: new Date(row.punch_time).toISOString(),
    recordHash: row.record_hash,
    source: row.source,
  }));
  const holidays = await query<HolidayRule>(
    `select year, month, day, name from public.holidays
     where tenant_id=$1 or tenant_id is null`,
    [tenantId],
  );
  const { days } = buildTimeMirror(punches, timeZone, holidays);
  const apuracao = apurarJornada(days, {
    expectedMinutesByWeekday: defaultExpectedByWeekday(
      Number(link.weekly_hours ?? 0),
    ),
    toleranceMinutesPerDay: toleranceMinutes,
  });
  return { apuracao, baseSalary: Number(link.base_salary ?? 0) };
}

/** Apuracao de jornada no periodo: previsto (da jornada semanal) x trabalhado, com
 *  tolerancia legal, extras e faltas por dia e no total. Feriado tem previsto 0. */
export const getTimeApuracao = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ApuracaoInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const { apuracao } = await loadApuracao(
      data.tenant_id,
      data.employment_link_id,
      data.from,
      data.to,
      data.time_zone,
      data.tolerance_minutes,
    );
    return apuracao;
  });

const DepositInput = z
  .object({
    tenant_id: z.string().uuid(),
    employment_link_id: z.string().uuid(),
    reference_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    // A politica e explicita: RH escolhe a rubrica de extras e a de faltas, o
    // adicional e o divisor do salario-hora. Nada e adivinhado pelo sistema.
    overtime_rubric_id: z.string().uuid().optional(),
    absence_rubric_id: z.string().uuid().optional(),
    overtime_multiplier: z.number().min(1).max(4).default(1.5),
    monthly_base_hours: z.number().min(1).max(400).default(220),
    tolerance_minutes: z.number().int().min(0).max(60).default(10),
    time_zone: z.string().max(64).optional(),
  })
  .refine((v) => v.overtime_rubric_id || v.absence_rubric_id, {
    message: "Informe ao menos uma rubrica (extras ou faltas)",
  });

const round2 = (value: number) => Number(value.toFixed(2));

/** Valora o ponto apurado (extras/faltas x salario-hora) e deposita em
 *  payroll_monthly_variables para o ciclo consumir (O1-04b). Fecha o laco
 *  ponto->folha. A valoracao usa parametros explicitos do RH. */
export const depositTimeApuracao = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => DepositInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.assignments.manage");
    const [year, month] = data.reference_month.split("-").map(Number);
    const from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const to = new Date(Date.UTC(year, month, 1) - 1).toISOString();
    const referenceDate = `${data.reference_month}-01`;
    // As rubricas informadas devem ser do ente.
    const rubricIds = [data.overtime_rubric_id, data.absence_rubric_id].filter(
      (id): id is string => Boolean(id),
    );
    const found = await queryOne<{ total: number }>(
      "select count(*)::int as total from public.payroll_rubrics where tenant_id=$1 and id=any($2::uuid[])",
      [data.tenant_id, rubricIds],
    );
    if ((found?.total ?? 0) !== new Set(rubricIds).size)
      throw new Error("Rubrica inválida para esta entidade");

    const { apuracao, baseSalary } = await loadApuracao(
      data.tenant_id,
      data.employment_link_id,
      from,
      to,
      data.time_zone,
      data.tolerance_minutes,
    );
    const valorHora = baseSalary / data.monthly_base_hours;
    const overtimeAmount = round2(
      (apuracao.totals.extraMinutes / 60) *
        valorHora *
        data.overtime_multiplier,
    );
    const absenceAmount = round2(
      (apuracao.totals.faltaMinutes / 60) * valorHora,
    );
    const deposits: Array<{ rubricId: string; amount: number }> = [];
    if (data.overtime_rubric_id)
      deposits.push({
        rubricId: data.overtime_rubric_id,
        amount: overtimeAmount,
      });
    if (data.absence_rubric_id)
      deposits.push({
        rubricId: data.absence_rubric_id,
        amount: absenceAmount,
      });

    await withTransaction(async (client) => {
      for (const deposit of deposits) {
        // Re-depositar substitui o valor da competencia (a chave unica trata o
        // source_batch_id nulo como distinto, entao apaga-e-insere).
        await client.query(
          `delete from public.payroll_monthly_variables
           where tenant_id=$1 and employment_link_id=$2 and rubric_id=$3
             and reference_month=$4 and source_batch_id is null`,
          [
            data.tenant_id,
            data.employment_link_id,
            deposit.rubricId,
            referenceDate,
          ],
        );
        if (deposit.amount > 0) {
          await client.query(
            `insert into public.payroll_monthly_variables
               (tenant_id, employment_link_id, rubric_id, reference_month, amount,
                installment_number, installments_total)
             values ($1,$2,$3,$4,$5,1,1)`,
            [
              data.tenant_id,
              data.employment_link_id,
              deposit.rubricId,
              referenceDate,
              deposit.amount,
            ],
          );
        }
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "deposit",
        resource: "payroll_monthly_variables",
        recordId: data.employment_link_id,
        before: null,
        after: {
          reference_month: referenceDate,
          extra_minutes: apuracao.totals.extraMinutes,
          falta_minutes: apuracao.totals.faltaMinutes,
          overtime_amount: overtimeAmount,
          absence_amount: absenceAmount,
        },
      });
    });
    return {
      extraMinutes: apuracao.totals.extraMinutes,
      faltaMinutes: apuracao.totals.faltaMinutes,
      overtimeAmount,
      absenceAmount,
    };
  });
