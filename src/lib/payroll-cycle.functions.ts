import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
  requireCriticalMfa,
  type TenantPermission,
} from "./tenant-access.server";

const TenantInput = z.object({ tenant_id: z.string().uuid() });

function auditMetadata() {
  const request = getRequest();
  return {
    requestId: request?.headers?.get("x-request-id") ?? randomUUID(),
    ip: request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
  };
}

function checksum(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export const getPayrollCycleWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.cycles.read");
    const [runs, cycles, results, events] = await Promise.all([
      query<{
        id: string;
        reference_month: string;
        engine_version: string;
        links_processed: number;
        completed_at: string;
      }>(
        `select id,reference_month::text,engine_version,links_processed,
           completed_at::text
         from public.payroll_calculation_runs
         where tenant_id=$1 and status='concluida' and run_type='simulacao'
         order by reference_month desc,completed_at desc limit 60`,
        [data.tenant_id],
      ),
      query<{
        id: string;
        reference_month: string;
        cycle_type: string;
        sequence: number;
        status: string;
        source_run_id: string | null;
        version: number;
        links_count: number;
        items_count: number;
        total_earnings: number;
        total_deductions: number;
        total_net: number;
        prepared_by: string | null;
        prepared_at: string;
        review_started_at: string | null;
        approved_at: string | null;
        closed_at: string | null;
        reopened_at: string | null;
        reopen_reason: string | null;
      }>(
        `select id,reference_month::text,cycle_type,sequence,status,source_run_id,
           version,links_count,items_count,total_earnings,total_deductions,total_net,
           prepared_by,prepared_at::text,review_started_at::text,approved_at::text,
           closed_at::text,reopened_at::text,reopen_reason
         from public.payroll_cycles where tenant_id=$1 and cycle_type='mensal'
         order by reference_month desc,sequence desc`,
        [data.tenant_id],
      ),
      query<{
        id: string;
        cycle_id: string;
        employment_link_id: string;
        registration_number: string;
        full_name: string;
        earnings: number;
        deductions: number;
        informational: number;
        net_amount: number;
        items_count: number;
        result_checksum: string;
      }>(
        `select result.id,result.cycle_id,result.employment_link_id,
           link.registration_number,person.full_name,result.earnings,
           result.deductions,result.informational,result.net_amount,
           result.items_count,result.result_checksum
         from public.payroll_cycle_results result
         join public.employment_links link on link.id=result.employment_link_id
         join public.persons person on person.id=link.person_id
         where result.tenant_id=$1
         order by person.full_name,link.registration_number`,
        [data.tenant_id],
      ),
      query<{
        id: number;
        cycle_id: string;
        from_status: string | null;
        to_status: string;
        reason: string | null;
        occurred_at: string;
      }>(
        `select id,cycle_id,from_status,to_status,reason,occurred_at::text
         from public.payroll_cycle_events where tenant_id=$1
         order by occurred_at desc,id desc limit 300`,
        [data.tenant_id],
      ),
    ]);
    return {
      runs,
      cycles,
      results,
      events,
      permissions: {
        prepare: access.permissions.includes("payroll.cycles.prepare"),
        approve: access.permissions.includes("payroll.cycles.approve"),
        close: access.permissions.includes("payroll.cycles.close"),
        reopen: access.permissions.includes("payroll.cycles.reopen"),
      },
    };
  });

type MaterializedResult = {
  employment_link_id: string;
  earnings: number;
  deductions: number;
  informational: number;
  net_amount: number;
  items_count: number;
  memory: unknown[];
};

async function loadRunResults(
  client: import("pg").PoolClient,
  tenantId: string,
  runId: string,
  referenceDate: string,
) {
  const run = await client.query<{
    id: string;
    status: string;
    reference_month: string;
  }>(
    `select id,status,reference_month::text from public.payroll_calculation_runs
     where id=$1 and tenant_id=$2 for update`,
    [runId, tenantId],
  );
  const source = run.rows[0];
  if (!source || source.status !== "concluida")
    throw new Error("Selecione uma simulação concluída desta entidade");
  if (source.reference_month.slice(0, 10) !== referenceDate)
    throw new Error("A simulação não pertence à competência informada");

  const rows = await client.query<{
    employment_link_id: string;
    earnings: string;
    deductions: string;
    informational: string;
    items_count: string;
    memory: unknown[];
  }>(
    `select item.employment_link_id,
       coalesce(sum(case when rubric.nature='provento' then item.amount else 0 end),0)::text as earnings,
       coalesce(sum(case when rubric.nature='desconto' then item.amount else 0 end),0)::text as deductions,
       coalesce(sum(case when rubric.nature='informativa' then item.amount else 0 end),0)::text as informational,
       count(*)::text as items_count,
       jsonb_agg(jsonb_build_object(
         'item_id',item.id,'rubric_id',item.rubric_id,'rubric_code',rubric.code,
         'nature',rubric.nature,'amount',item.amount,'sequence',item.sequence,
         'formula_checksum',item.formula_checksum,'memory',item.memory
       ) order by item.sequence,rubric.code) as memory
     from public.payroll_calculation_items item
     join public.payroll_rubrics rubric on rubric.id=item.rubric_id
     where item.tenant_id=$1 and item.run_id=$2
     group by item.employment_link_id order by item.employment_link_id`,
    [tenantId, runId],
  );
  if (!rows.rows.length)
    throw new Error("A simulação não possui resultados para materializar");
  return rows.rows.map((row): MaterializedResult => {
    const earnings = Number(row.earnings);
    const deductions = Number(row.deductions);
    return {
      employment_link_id: row.employment_link_id,
      earnings,
      deductions,
      informational: Number(row.informational),
      net_amount: Number((earnings - deductions).toFixed(2)),
      items_count: Number(row.items_count),
      memory: row.memory,
    };
  });
}

async function insertResults(
  client: import("pg").PoolClient,
  tenantId: string,
  cycleId: string,
  runId: string,
  rows: MaterializedResult[],
) {
  for (const row of rows) {
    const digest = checksum({
      cycle_id: cycleId,
      source_run_id: runId,
      employment_link_id: row.employment_link_id,
      earnings: row.earnings,
      deductions: row.deductions,
      informational: row.informational,
      net_amount: row.net_amount,
      items_count: row.items_count,
      memory: row.memory,
    });
    await client.query(
      `insert into public.payroll_cycle_results
         (tenant_id,cycle_id,employment_link_id,source_run_id,earnings,deductions,
          informational,net_amount,items_count,calculation_memory,result_checksum)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [
        tenantId,
        cycleId,
        row.employment_link_id,
        runId,
        row.earnings,
        row.deductions,
        row.informational,
        row.net_amount,
        row.items_count,
        JSON.stringify(row.memory),
        digest,
      ],
    );
  }
  return rows.reduce(
    (total, row) => ({
      links: total.links + 1,
      items: total.items + row.items_count,
      earnings: total.earnings + row.earnings,
      deductions: total.deductions + row.deductions,
      net: total.net + row.net_amount,
    }),
    { links: 0, items: 0, earnings: 0, deductions: 0, net: 0 },
  );
}

async function applyAdvanceCompensations(
  client: import("pg").PoolClient,
  tenantId: string,
  referenceDate: string,
  monthlyCycleId: string,
  rows: MaterializedResult[],
) {
  const advances = await client.query<{
    advance_cycle_id: string;
    employment_link_id: string;
    amount: string;
  }>(
    `select cycle.id as advance_cycle_id,result.employment_link_id,
       result.net_amount::text as amount
     from public.payroll_cycles cycle
     join public.payroll_cycle_results result on result.cycle_id=cycle.id
     left join public.payroll_advance_compensations compensation
       on compensation.advance_cycle_id=cycle.id
      and compensation.employment_link_id=result.employment_link_id
     where cycle.tenant_id=$1 and cycle.reference_month=$2
       and cycle.cycle_type='adiantamento' and cycle.status='fechada'
       and compensation.id is null
     order by cycle.id,result.employment_link_id`,
    [tenantId, referenceDate],
  );
  const byLink = new Map(rows.map((row) => [row.employment_link_id, row]));
  for (const advance of advances.rows) {
    const result = byLink.get(advance.employment_link_id);
    if (!result)
      throw new Error(
        "A simulação mensal não contém todos os vínculos com adiantamento a compensar",
      );
    const amount = Number(advance.amount);
    result.deductions = Number((result.deductions + amount).toFixed(2));
    result.net_amount = Number(
      (result.earnings - result.deductions).toFixed(2),
    );
    result.items_count += 1;
    result.memory = [
      ...result.memory,
      {
        type: "compensacao_adiantamento",
        advance_cycle_id: advance.advance_cycle_id,
        amount,
      },
    ];
    await client.query(
      `insert into public.payroll_advance_compensations
         (tenant_id,advance_cycle_id,monthly_cycle_id,employment_link_id,amount)
       values ($1,$2,$3,$4,$5)`,
      [
        tenantId,
        advance.advance_cycle_id,
        monthlyCycleId,
        advance.employment_link_id,
        amount,
      ],
    );
  }
  return advances.rows.length;
}

const PreviewInput = z.object({
  tenant_id: z.string().uuid(),
  reference_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  source_run_id: z.string().uuid(),
  cycle_id: z.string().uuid().optional(),
  expected_version: z.number().int().positive().optional(),
});

export const materializePayrollPreview = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => PreviewInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.cycles.prepare");
    const referenceDate = `${data.reference_month}-01`;
    const event = auditMetadata();
    return withTransaction(async (client) => {
      const rows = await loadRunResults(
        client,
        data.tenant_id,
        data.source_run_id,
        referenceDate,
      );
      const cycleId = data.cycle_id ?? randomUUID();
      let fromStatus: string | null = null;
      let nextVersion = 1;
      if (data.cycle_id) {
        const current = await client.query<{
          status: string;
          version: number;
        }>(
          `select status,version from public.payroll_cycles
           where id=$1 and tenant_id=$2 for update`,
          [cycleId, data.tenant_id],
        );
        if (!current.rows[0]) throw new Error("Ciclo não encontrado");
        if (current.rows[0].status !== "reaberta")
          throw new Error("Somente uma folha reaberta aceita nova prévia");
        if (current.rows[0].version !== data.expected_version)
          throw new Error(
            "A folha foi alterada por outro usuário; atualize a tela",
          );
        fromStatus = current.rows[0].status;
        nextVersion = current.rows[0].version + 1;
        await client.query(
          "delete from public.payroll_cycle_results where cycle_id=$1",
          [cycleId],
        );
        await client.query(
          "delete from public.payroll_advance_compensations where monthly_cycle_id=$1",
          [cycleId],
        );
      } else {
        await client.query(
          `insert into public.payroll_cycles
             (id,tenant_id,reference_month,cycle_type,sequence,status,
              source_run_id,version,prepared_by)
           values ($1,$2,$3,'mensal',1,'previa',$4,1,$5)`,
          [
            cycleId,
            data.tenant_id,
            referenceDate,
            data.source_run_id,
            context.userId,
          ],
        );
      }
      const compensations = await applyAdvanceCompensations(
        client,
        data.tenant_id,
        referenceDate,
        cycleId,
        rows,
      );
      const totals = await insertResults(
        client,
        data.tenant_id,
        cycleId,
        data.source_run_id,
        rows,
      );
      await client.query(
        `update public.payroll_cycles set status='previa',source_run_id=$3,
           version=$4,links_count=$5,items_count=$6,total_earnings=$7,
           total_deductions=$8,total_net=$9,prepared_by=$10,prepared_at=now(),
           review_started_by=null,review_started_at=null,approved_by=null,
           approved_at=null,closed_by=null,closed_at=null
         where id=$1 and tenant_id=$2`,
        [
          cycleId,
          data.tenant_id,
          data.source_run_id,
          nextVersion,
          totals.links,
          totals.items,
          Number(totals.earnings.toFixed(2)),
          Number(totals.deductions.toFixed(2)),
          Number(totals.net.toFixed(2)),
          context.userId,
        ],
      );
      await client.query(
        `insert into public.payroll_cycle_events
           (tenant_id,cycle_id,from_status,to_status,actor_id,payload)
         values ($1,$2,$3,'previa',$4,$5::jsonb)`,
        [
          data.tenant_id,
          cycleId,
          fromStatus,
          context.userId,
          JSON.stringify({
            source_run_id: data.source_run_id,
            version: nextVersion,
            ...totals,
            compensations,
          }),
        ],
      );
      await client.query(
        `insert into public.audit_events
           (tenant_id,actor_id,action,resource,record_id,after_data,request_id,ip)
         values ($1,$2,'materialize_preview','payroll_cycles',$3,$4::jsonb,$5,$6::inet)`,
        [
          data.tenant_id,
          context.userId,
          cycleId,
          JSON.stringify({
            reference_month: referenceDate,
            version: nextVersion,
            ...totals,
            compensations,
          }),
          event.requestId,
          event.ip,
        ],
      );
      return { cycleId, version: nextVersion, compensations, ...totals };
    });
  });

const TransitionInput = z.object({
  tenant_id: z.string().uuid(),
  cycle_id: z.string().uuid(),
  expected_version: z.number().int().positive(),
  action: z.enum(["review", "approve", "close", "reopen"]),
  reason: z.string().trim().max(1000).optional(),
});

const transitionRules = {
  review: {
    from: "previa",
    to: "em_conferencia",
    permission: "payroll.cycles.prepare",
  },
  approve: {
    from: "em_conferencia",
    to: "aprovada",
    permission: "payroll.cycles.approve",
  },
  close: {
    from: "aprovada",
    to: "fechada",
    permission: "payroll.cycles.close",
  },
  reopen: {
    from: "fechada",
    to: "reaberta",
    permission: "payroll.cycles.reopen",
  },
} as const satisfies Record<
  string,
  { from: string; to: string; permission: TenantPermission }
>;

export const transitionPayrollCycle = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TransitionInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    const rule = transitionRules[data.action];
    requireTenantPermission(access, rule.permission);
    requireCriticalMfa(rule.permission, context.mfaVerifiedAt);
    if (data.action === "reopen" && (data.reason?.length ?? 0) < 10)
      throw new Error(
        "Informe uma justificativa de reabertura com ao menos 10 caracteres",
      );
    const event = auditMetadata();
    return withTransaction(async (client) => {
      const current = await client.query<{
        status: string;
        version: number;
        prepared_by: string | null;
      }>(
        `select status,version,prepared_by from public.payroll_cycles
         where id=$1 and tenant_id=$2 for update`,
        [data.cycle_id, data.tenant_id],
      );
      const cycle = current.rows[0];
      if (!cycle) throw new Error("Ciclo não encontrado");
      if (cycle.version !== data.expected_version)
        throw new Error(
          "A folha foi alterada por outro usuário; atualize a tela",
        );
      if (cycle.status !== rule.from)
        throw new Error(`A ação exige folha em ${rule.from}`);
      if (data.action === "approve" && cycle.prepared_by === context.userId)
        throw new Error(
          "Segregação de funções: quem preparou não pode aprovar a mesma folha",
        );

      const stamp =
        data.action === "review"
          ? "review_started_by=$5,review_started_at=now()"
          : data.action === "approve"
            ? "approved_by=$5,approved_at=now()"
            : data.action === "close"
              ? "closed_by=$5,closed_at=now()"
              : "reopened_by=$5,reopened_at=now(),reopen_reason=$6";
      await client.query(
        `update public.payroll_cycles set status=$3,${stamp}
         where id=$1 and tenant_id=$2 and version=$4`,
        [
          data.cycle_id,
          data.tenant_id,
          rule.to,
          data.expected_version,
          context.userId,
          data.reason || null,
        ],
      );
      await client.query(
        `insert into public.payroll_cycle_events
           (tenant_id,cycle_id,from_status,to_status,reason,actor_id,payload)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          data.tenant_id,
          data.cycle_id,
          rule.from,
          rule.to,
          data.reason || null,
          context.userId,
          JSON.stringify({ version: data.expected_version }),
        ],
      );
      await client.query(
        `insert into public.audit_events
           (tenant_id,actor_id,action,resource,record_id,before_data,after_data,request_id,ip)
         values ($1,$2,$3,'payroll_cycles',$4,$5::jsonb,$6::jsonb,$7,$8::inet)`,
        [
          data.tenant_id,
          context.userId,
          data.action,
          data.cycle_id,
          JSON.stringify({ status: rule.from }),
          JSON.stringify({
            status: rule.to,
            reason: data.reason || null,
            version: data.expected_version,
          }),
          event.requestId,
          event.ip,
        ],
      );
      return { cycleId: data.cycle_id, status: rule.to };
    });
  });
