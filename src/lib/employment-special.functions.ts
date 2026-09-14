import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
import { calculateTerminationTaxes } from "./payroll-special";
import { loadFiscalTables } from "./fiscal-tables.server";

const Tenant = z.object({ tenant_id: z.string().uuid() });
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const getEmploymentSpecialWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((value: unknown) => parseInput(Tenant, value))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    if (
      !access.permissions.includes("employment.special.read") &&
      !access.permissions.includes("termination.read")
    )
      throw new Error("Sem permissão para eventos funcionais");
    const [links, events, terminations, careers] = await Promise.all([
      query<any>(
        `select l.id,l.registration_number,l.status,l.base_salary,l.admission_date::text,l.termination_date::text,p.full_name
        from public.employment_links l join public.persons p on p.id=l.person_id where l.tenant_id=$1 order by p.full_name`,
        [data.tenant_id],
      ),
      access.permissions.includes("employment.special.read")
        ? query<any>(
            `select * from public.employment_special_events where tenant_id=$1 order by effective_date desc,created_at desc`,
            [data.tenant_id],
          )
        : Promise.resolve([]),
      access.permissions.includes("termination.read")
        ? query<any>(
            `select t.*,p.full_name,l.registration_number from public.termination_calculations t join public.employment_links l on l.id=t.employment_link_id join public.persons p on p.id=l.person_id where t.tenant_id=$1 order by t.termination_date desc`,
            [data.tenant_id],
          )
        : Promise.resolve([]),
      query<any>(
        `select * from public.career_levels where tenant_id=$1 order by career_code,class_code,level_code,effective_from desc`,
        [data.tenant_id],
      ),
    ]);
    return {
      links,
      events,
      terminations,
      careers,
      canManageEvents: access.permissions.includes("employment.special.manage"),
      canManageTerminations: access.permissions.includes("termination.manage"),
    };
  });

const EventInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  event_type: z.enum([
    "reativacao",
    "readaptacao",
    "progressao",
    "reintegracao",
  ]),
  effective_date: z.string().date(),
  end_date: z.string().date().optional(),
  target_job_title: z.string().trim().max(160).optional(),
  new_base_salary: z.number().min(0).optional(),
  legal_basis: z.string().trim().min(3).max(500),
  notes: z.string().max(500).optional(),
});
export const saveEmploymentSpecialEvent = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((value: unknown) => parseInput(EventInput, value))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "employment.special.manage");
    if (
      data.event_type === "readaptacao" &&
      (!data.end_date || !data.target_job_title)
    )
      throw new Error("Readaptação exige função temporária e data final");
    if (data.event_type === "progressao" && data.new_base_salary == null)
      throw new Error("Progressão exige novo salário");
    const id = randomUUID();
    await query(
      `insert into public.employment_special_events(id,tenant_id,employment_link_id,event_type,effective_date,end_date,target_job_title,new_base_salary,legal_basis,notes,created_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        data.tenant_id,
        data.employment_link_id,
        data.event_type,
        data.effective_date,
        data.end_date ?? null,
        data.target_job_title ?? null,
        data.new_base_salary ?? null,
        data.legal_basis,
        data.notes ?? null,
        context.userId,
      ],
    );
    return { id };
  });

export const processDueEmploymentEvents = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((value: unknown) => parseInput(Tenant, value))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "employment.special.manage");
    return withTransaction(async (client) => {
      const due = await client.query<any>(
        `select e.*,l.status as link_status from public.employment_special_events e join public.employment_links l on l.id=e.employment_link_id where e.tenant_id=$1 and e.status='agendado' and e.effective_date<=current_date order by e.effective_date,e.id for update`,
        [data.tenant_id],
      );
      for (const event of due.rows) {
        if (
          event.event_type === "reintegracao" &&
          event.link_status !== "desligado"
        )
          throw new Error("Reintegração exige vínculo desligado");
        const newStatus = ["reativacao", "reintegracao"].includes(
          event.event_type,
        )
          ? "ativo"
          : event.link_status;
        await client.query(
          `update public.employment_links set status=$2,termination_date=case when $3 then null else termination_date end,base_salary=coalesce($4,base_salary),job_title=coalesce($5,job_title) where id=$1`,
          [
            event.employment_link_id,
            newStatus,
            event.event_type === "reintegracao",
            event.new_base_salary,
            event.target_job_title,
          ],
        );
        await client.query(
          `update public.employment_special_events set status='aplicado',applied_at=now() where id=$1`,
          [event.id],
        );
        await client.query(
          `insert into public.employment_link_movements(tenant_id,employment_link_id,movement_type,effective_date,from_status,to_status,before_data,after_data,legal_basis,notes,applied_at,created_by) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,now(),$11)`,
          [
            data.tenant_id,
            event.employment_link_id,
            event.event_type,
            event.effective_date,
            event.link_status,
            newStatus,
            JSON.stringify({ status: event.link_status }),
            JSON.stringify({
              status: newStatus,
              base_salary: event.new_base_salary,
              job_title: event.target_job_title,
            }),
            event.legal_basis,
            event.notes,
            context.userId,
          ],
        );
      }
      return { processed: due.rows.length };
    });
  });

const TerminationInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  termination_date: z.string().date(),
  reason: z.enum([
    "sem_justa_causa",
    "pedido_demissao",
    "justa_causa",
    "termino_contrato",
    "aposentadoria",
  ]),
  notice_type: z.enum(["trabalhado", "indenizado", "dispensado"]),
  worked_days: z.number().int().min(0).max(30),
  thirteenth_months: z.number().int().min(0).max(12),
  vacation_months: z.number().int().min(0).max(12),
  fgts_balance: z.number().min(0).default(0),
  fgts_penalty_rate: z.number().min(0).max(1).default(0),
  other_earnings: z.number().min(0).default(0),
  deductions: z.number().min(0).default(0),
});
export const calculateTermination = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((value: unknown) => parseInput(TerminationInput, value))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "termination.manage");
    const link = (
      await query<any>(
        `select base_salary from public.employment_links where id=$1 and tenant_id=$2`,
        [data.employment_link_id, data.tenant_id],
      )
    )[0];
    if (!link?.base_salary) throw new Error("Vínculo sem salário-base");
    const salary = Number(link.base_salary);
    const verbas = {
      salary_balance: +((salary / 30) * data.worked_days).toFixed(2),
      notice_amount: data.notice_type === "indenizado" ? salary : 0,
      thirteenth_amount: +((salary * data.thirteenth_months) / 12).toFixed(2),
      vacation_amount: +(
        (((salary * data.vacation_months) / 12) * 4) /
        3
      ).toFixed(2),
      fgts_penalty: +(data.fgts_balance * data.fgts_penalty_rate).toFixed(2),
    };

    // Tabelas fiscais versionadas vigentes na competencia da rescisao (O1-01b):
    // INSS/IRRF saem do motor do ADR 0003, com checksum na memoria (defensavel
    // perante o TCE). A rescisao aqui e de regime celetista/temporario (modela
    // FGTS e aviso previo); a exoneracao de estatutario/RPPS e outro fluxo.
    const fiscalTables = await loadFiscalTables(
      data.tenant_id,
      data.termination_date,
    );
    const inssTable = fiscalTables.get("INSS_FEDERAL");
    const irrfTable = fiscalTables.get("IRRF_FEDERAL");
    if (!inssTable || !irrfTable)
      throw new Error(
        "Tabelas fiscais INSS/IRRF não encontradas para a competência da rescisão",
      );
    const taxes = calculateTerminationTaxes({
      salaryBalance: verbas.salary_balance,
      thirteenthAmount: verbas.thirteenth_amount,
      noticeAmount: verbas.notice_amount,
      vacationAmount: verbas.vacation_amount,
      fgtsPenalty: verbas.fgts_penalty,
      inssBrackets: inssTable.brackets,
      irrfBrackets: irrfTable.brackets,
    });

    const total = +(
      verbas.salary_balance +
      verbas.notice_amount +
      verbas.thirteenth_amount +
      verbas.vacation_amount +
      verbas.fgts_penalty +
      data.other_earnings
    ).toFixed(2);
    // Liquido = proventos - INSS - IRRF - outros descontos manuais (data.deductions,
    // ex.: pensao alimenticia, adiantamentos). `other_earnings` fica fora da base
    // automatica (bucket indenizatorio do operador); verba tributavel entra por
    // rubrica no ciclo, nao aqui.
    const net = +(
      total -
      taxes.inssTotal -
      taxes.irrfTotal -
      data.deductions
    ).toFixed(2);
    const memory = {
      salary,
      inputs: data,
      ...verbas,
      taxes: {
        inss: taxes.inssTotal,
        irrf: taxes.irrfTotal,
        breakdown: {
          inss_salario: taxes.inssSalario,
          irrf_salario: taxes.irrfSalario,
          inss_decimo: taxes.inssThirteenth,
          irrf_decimo: taxes.irrfThirteenth,
        },
        taxable: {
          competencia: taxes.taxableSalary,
          decimo_terceiro: taxes.taxableThirteenth,
        },
        exempt: {
          aviso_previo_indenizado: verbas.notice_amount,
          ferias_indenizadas: verbas.vacation_amount,
          fgts: verbas.fgts_penalty,
          other_earnings: data.other_earnings,
          total: taxes.exemptTotal,
        },
        rule: "INSS/IRRF sobre saldo de salario (competencia) e 13o (exclusiva); verbas indenizatorias isentas.",
        // Provenancia fiscal: id + checksum das versoes vigentes usadas (ADR 0003).
        snapshot: {
          inss: {
            code: "INSS_FEDERAL",
            version_id: inssTable.versionId,
            checksum: inssTable.checksum,
          },
          irrf: {
            code: "IRRF_FEDERAL",
            version_id: irrfTable.versionId,
            checksum: irrfTable.checksum,
          },
        },
      },
      other_deductions: data.deductions,
      engine_version: "termination-v1.1.0",
    };
    const id = randomUUID();
    await query(
      `insert into public.termination_calculations(id,tenant_id,employment_link_id,termination_date,reason,notice_type,worked_days,thirteenth_months,vacation_months,fgts_balance,fgts_penalty_rate,other_earnings,deductions,salary_balance,notice_amount,thirteenth_amount,vacation_amount,fgts_penalty,inss_amount,irrf_amount,total_earnings,net_amount,memory,result_checksum,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,$25)`,
      [
        id,
        data.tenant_id,
        data.employment_link_id,
        data.termination_date,
        data.reason,
        data.notice_type,
        data.worked_days,
        data.thirteenth_months,
        data.vacation_months,
        data.fgts_balance,
        data.fgts_penalty_rate,
        data.other_earnings,
        data.deductions,
        verbas.salary_balance,
        verbas.notice_amount,
        verbas.thirteenth_amount,
        verbas.vacation_amount,
        verbas.fgts_penalty,
        taxes.inssTotal,
        taxes.irrfTotal,
        total,
        net,
        JSON.stringify(memory),
        digest(memory),
        context.userId,
      ],
    );
    return { id, net, inss: taxes.inssTotal, irrf: taxes.irrfTotal };
  });

const ApplyTermination = z.object({
  tenant_id: z.string().uuid(),
  termination_id: z.string().uuid(),
});
export const applyTermination = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => parseInput(ApplyTermination, v))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "termination.manage");
    return withTransaction(async (client) => {
      const r = await client.query<any>(
        `select * from public.termination_calculations where id=$1 and tenant_id=$2 and status='rascunho' for update`,
        [data.termination_id, data.tenant_id],
      );
      const t = r.rows[0];
      if (!t) throw new Error("Rescisão não disponível");
      await client.query(
        `update public.termination_calculations set status='efetivada',approved_by=$2,approved_at=now(),applied_by=$2,applied_at=now() where id=$1`,
        [t.id, context.userId],
      );
      await client.query(
        `update public.employment_links set status='desligado',termination_date=$2 where id=$1`,
        [t.employment_link_id, t.termination_date],
      );
      return { id: t.id };
    });
  });
