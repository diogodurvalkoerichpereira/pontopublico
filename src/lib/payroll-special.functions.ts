import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  loadTenantUnitScope,
  requireTenantPermission,
  requireUnitInScope,
} from "./tenant-access.server";
import {
  calculateThirteenthSalary,
  countThirteenthSalaryMonths,
  type IncomeTaxBand,
  type ProgressiveBand,
} from "./payroll-special";

const TenantInput = z.object({ tenant_id: z.string().uuid() });

function checksum(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export const getSpecialPayrollWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.special.read");
    const [links, cycles, results, monthlyCycles, adjustments] =
      await Promise.all([
        query<{
          id: string;
          registration_number: string;
          full_name: string;
          base_salary: number | null;
          admission_date: string;
          termination_date: string | null;
          unit_id: string | null;
        }>(
          `select link.id,link.registration_number,person.full_name,link.base_salary,
           link.admission_date::text,link.termination_date::text,link.unit_id
         from public.employment_links link
         join public.persons person on person.id=link.person_id
         where link.tenant_id=$1 and link.status<>'desligado'
         order by person.full_name,link.registration_number`,
          [data.tenant_id],
        ),
        query<{
          id: string;
          reference_month: string;
          cycle_type:
            | "adiantamento"
            | "complementar"
            | "decimo_primeira"
            | "decimo_segunda";
          sequence: number;
          status: string;
          source_cycle_id: string | null;
          calculation_method: string | null;
          configuration: Record<string, unknown>;
          version: number;
          links_count: number;
          items_count: number;
          total_earnings: number;
          total_deductions: number;
          total_net: number;
          prepared_by: string | null;
          reopen_reason: string | null;
        }>(
          `select id,reference_month::text,cycle_type,sequence,status,source_cycle_id,
           calculation_method,configuration,version,links_count,items_count,
           total_earnings,total_deductions,total_net,prepared_by,reopen_reason
         from public.payroll_cycles
         where tenant_id=$1 and cycle_type<>'mensal'
         order by reference_month desc,cycle_type,sequence desc`,
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
          net_amount: number;
          items_count: number;
          calculation_memory: unknown[];
          result_checksum: string;
        }>(
          `select result.id,result.cycle_id,result.employment_link_id,
           link.registration_number,person.full_name,result.earnings,
           result.deductions,result.net_amount,result.items_count,
           result.calculation_memory,result.result_checksum
         from public.payroll_cycle_results result
         join public.payroll_cycles cycle on cycle.id=result.cycle_id
         join public.employment_links link on link.id=result.employment_link_id
         join public.persons person on person.id=link.person_id
         where result.tenant_id=$1 and cycle.cycle_type<>'mensal'
         order by person.full_name,link.registration_number`,
          [data.tenant_id],
        ),
        query<{ id: string; reference_month: string; total_net: number }>(
          `select id,reference_month::text,total_net from public.payroll_cycles
         where tenant_id=$1 and cycle_type='mensal' and status='fechada'
         order by reference_month desc`,
          [data.tenant_id],
        ),
        query<{
          id: string;
          cycle_id: string;
          employment_link_id: string;
          nature: "provento" | "desconto";
          amount: number;
          reason: string;
        }>(
          `select id,cycle_id,employment_link_id,nature,amount,reason
         from public.payroll_special_adjustments where tenant_id=$1
         order by created_at,id`,
          [data.tenant_id],
        ),
      ]);
    return {
      links,
      cycles,
      results,
      monthlyCycles,
      adjustments,
      permissions: {
        manage: access.permissions.includes("payroll.special.manage"),
        approve: access.permissions.includes("payroll.cycles.approve"),
        close: access.permissions.includes("payroll.cycles.close"),
        reopen: access.permissions.includes("payroll.cycles.reopen"),
      },
    };
  });

const AdjustmentInput = z.object({
  employment_link_id: z.string().uuid(),
  nature: z.enum(["provento", "desconto"]),
  amount: z.number().positive().max(1_000_000_000),
  reason: z.string().trim().min(5).max(500),
});

const CreateInput = z.object({
  tenant_id: z.string().uuid(),
  reference_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  cycle_type: z.enum([
    "adiantamento",
    "complementar",
    "decimo_primeira",
    "decimo_segunda",
  ]),
  employment_link_ids: z.array(z.string().uuid()).max(1000).default([]),
  advance_percentage: z.number().min(1).max(100).optional(),
  calculation_method: z
    .enum(["ultimo_salario", "media_remuneratoria"])
    .optional(),
  source_cycle_id: z.string().uuid().optional(),
  adjustments: z.array(AdjustmentInput).max(2000).default([]),
});

type SpecialResult = {
  linkId: string;
  earnings: number;
  deductions: number;
  memory: Array<Record<string, unknown>>;
  items: number;
};

export const createSpecialPayroll = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => CreateInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.special.manage");
    const scope = await loadTenantUnitScope(access, "payroll.special.manage");
    if (data.cycle_type === "adiantamento" && !data.advance_percentage)
      throw new Error("Informe o percentual do adiantamento");
    if (
      data.cycle_type === "complementar" &&
      (!data.source_cycle_id || !data.adjustments.length)
    )
      throw new Error(
        "Folha complementar exige origem fechada e ao menos um ajuste",
      );
    if (data.cycle_type.startsWith("decimo_") && !data.calculation_method)
      throw new Error("Selecione o método de base do 13º salário");

    const selectedIds =
      data.cycle_type === "complementar"
        ? [...new Set(data.adjustments.map((item) => item.employment_link_id))]
        : [...new Set(data.employment_link_ids)];
    if (!selectedIds.length) throw new Error("Selecione ao menos um vínculo");
    const referenceDate = `${data.reference_month}-01`;
    const referenceYear = Number(data.reference_month.slice(0, 4));

    return withTransaction(async (client) => {
      const linksResult = await client.query<{
        id: string;
        registration_number: string;
        base_salary: string | null;
        admission_date: string;
        termination_date: string | null;
        unit_id: string | null;
      }>(
        `select id,registration_number,base_salary::text,admission_date::text,
           termination_date::text,unit_id
         from public.employment_links
         where tenant_id=$1 and id=any($2::uuid[]) and status<>'desligado'
         order by id for update`,
        [data.tenant_id, selectedIds],
      );
      if (linksResult.rows.length !== selectedIds.length)
        throw new Error("Há vínculo inválido ou desligado na seleção");
      linksResult.rows.forEach((link) =>
        requireUnitInScope(scope, link.unit_id),
      );

      const duplicate = await client.query(
        `select id from public.payroll_cycles
         where tenant_id=$1 and reference_month=$2 and cycle_type=$3
           and ($3='complementar' or sequence=1)`,
        [data.tenant_id, referenceDate, data.cycle_type],
      );
      if (duplicate.rows.length && data.cycle_type !== "complementar")
        throw new Error("Este tipo de folha já existe na competência");

      let sequence = 1;
      if (data.cycle_type === "complementar") {
        const source = await client.query<{
          status: string;
          cycle_type: string;
        }>(
          `select status,cycle_type from public.payroll_cycles
           where id=$1 and tenant_id=$2 and reference_month=$3 for update`,
          [data.source_cycle_id, data.tenant_id, referenceDate],
        );
        if (
          source.rows[0]?.status !== "fechada" ||
          source.rows[0]?.cycle_type !== "mensal"
        )
          throw new Error(
            "A origem da complementar deve ser a folha mensal fechada",
          );
        const next = await client.query<{ sequence: number }>(
          `select coalesce(max(sequence),0)+1 as sequence from public.payroll_cycles
           where tenant_id=$1 and reference_month=$2 and cycle_type='complementar'`,
          [data.tenant_id, referenceDate],
        );
        sequence = Number(next.rows[0].sequence);
      }

      const configResult = await client.query<{
        teto_inss: string;
        inss_faixas: ProgressiveBand[];
        irrf_faixas: IncomeTaxBand[];
        deducao_dependente: string;
      }>(
        `select teto_inss::text,inss_faixas,irrf_faixas,deducao_dependente::text
         from public.payroll_config order by updated_at desc limit 1`,
      );
      const taxConfig = configResult.rows[0];
      if (data.cycle_type.startsWith("decimo_") && !taxConfig)
        throw new Error("Configuração de INSS/IRRF não encontrada");

      const historyResult = await client.query<{
        employment_link_id: string;
        average_earnings: string;
        months: string;
      }>(
        `select result.employment_link_id,avg(result.earnings)::text as average_earnings,
           count(*)::text as months
         from public.payroll_cycle_results result
         join public.payroll_cycles cycle on cycle.id=result.cycle_id
         where result.tenant_id=$1 and result.employment_link_id=any($2::uuid[])
           and cycle.cycle_type='mensal' and cycle.status='fechada'
           and extract(year from cycle.reference_month)=$3
           and cycle.reference_month<$4::date
         group by result.employment_link_id`,
        [data.tenant_id, selectedIds, referenceYear, referenceDate],
      );
      const history = new Map(
        historyResult.rows.map((item) => [item.employment_link_id, item]),
      );

      const firstResults =
        data.cycle_type === "decimo_segunda"
          ? await client.query<{
              employment_link_id: string;
              earnings: string;
            }>(
              `select result.employment_link_id,result.earnings::text
             from public.payroll_cycle_results result
             join public.payroll_cycles cycle on cycle.id=result.cycle_id
             where result.tenant_id=$1 and result.employment_link_id=any($2::uuid[])
               and cycle.cycle_type='decimo_primeira' and cycle.status='fechada'
               and extract(year from cycle.reference_month)=$3`,
              [data.tenant_id, selectedIds, referenceYear],
            )
          : {
              rows: [] as Array<{
                employment_link_id: string;
                earnings: string;
              }>,
            };
      if (
        data.cycle_type === "decimo_segunda" &&
        firstResults.rows.length !== selectedIds.length
      )
        throw new Error(
          "A segunda parcela exige primeira parcela fechada para todos os vínculos",
        );
      const firstPaid = new Map(
        firstResults.rows.map((item) => [
          item.employment_link_id,
          Number(item.earnings),
        ]),
      );

      const specialResults: SpecialResult[] = [];
      if (data.cycle_type === "complementar") {
        for (const linkId of selectedIds) {
          const items = data.adjustments.filter(
            (item) => item.employment_link_id === linkId,
          );
          const earnings = items
            .filter((item) => item.nature === "provento")
            .reduce((sum, item) => sum + item.amount, 0);
          const deductions = items
            .filter((item) => item.nature === "desconto")
            .reduce((sum, item) => sum + item.amount, 0);
          specialResults.push({
            linkId,
            earnings: Number(earnings.toFixed(2)),
            deductions: Number(deductions.toFixed(2)),
            items: items.length,
            memory: items.map((item) => ({
              type: "ajuste_complementar",
              nature: item.nature,
              amount: item.amount,
              reason: item.reason,
              source_cycle_id: data.source_cycle_id,
            })),
          });
        }
      } else {
        for (const link of linksResult.rows) {
          const salary = Number(link.base_salary ?? 0);
          if (salary <= 0)
            throw new Error(
              `Vínculo ${link.registration_number} sem salário-base`,
            );
          if (data.cycle_type === "adiantamento") {
            const amount = Number(
              (salary * (data.advance_percentage! / 100)).toFixed(2),
            );
            specialResults.push({
              linkId: link.id,
              earnings: amount,
              deductions: 0,
              items: 1,
              memory: [
                {
                  type: "adiantamento",
                  salary_base: salary,
                  percentage: data.advance_percentage,
                  amount,
                  compensation: "folha_mensal_da_mesma_competencia",
                },
              ],
            });
            continue;
          }
          const historyItem = history.get(link.id);
          const methodBase =
            data.calculation_method === "media_remuneratoria" && historyItem
              ? Number(historyItem.average_earnings)
              : salary;
          const months = countThirteenthSalaryMonths(
            referenceYear,
            link.admission_date,
            link.termination_date,
          );
          const calculation = calculateThirteenthSalary({
            calculationBase: methodBase,
            months,
            installment:
              data.cycle_type === "decimo_primeira" ? "primeira" : "segunda",
            firstInstallmentPaid: firstPaid.get(link.id),
            socialSecurityBands: taxConfig.inss_faixas,
            socialSecurityCeiling: Number(taxConfig.teto_inss),
            incomeTaxBands: taxConfig.irrf_faixas,
            dependentDeduction: Number(taxConfig.deducao_dependente),
          });
          specialResults.push({
            linkId: link.id,
            earnings: calculation.earnings,
            deductions: calculation.deductions,
            items: data.cycle_type === "decimo_primeira" ? 1 : 4,
            memory: [
              {
                type: "decimo_terceiro",
                installment: data.cycle_type === "decimo_primeira" ? 1 : 2,
                method: data.calculation_method,
                requested_method: data.calculation_method,
                applied_base: methodBase,
                salary_base: salary,
                history_months: Number(historyItem?.months ?? 0),
                average_fallback_to_salary:
                  data.calculation_method === "media_remuneratoria" &&
                  !historyItem,
                months,
                ...calculation,
              },
            ],
          });
        }
      }

      const totals = specialResults.reduce(
        (sum, item) => ({
          earnings: sum.earnings + item.earnings,
          deductions: sum.deductions + item.deductions,
          items: sum.items + item.items,
        }),
        { earnings: 0, deductions: 0, items: 0 },
      );
      const cycleId = randomUUID();
      const configuration = {
        advance_percentage: data.advance_percentage ?? null,
        calculation_method: data.calculation_method ?? null,
        tax_snapshot: taxConfig ?? null,
        engine_version: "special-v1.0.0",
      };
      await client.query(
        `insert into public.payroll_cycles
           (id,tenant_id,reference_month,cycle_type,sequence,status,version,
            source_cycle_id,calculation_method,configuration,links_count,items_count,
            total_earnings,total_deductions,total_net,prepared_by)
         values ($1,$2,$3,$4,$5,'previa',1,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)`,
        [
          cycleId,
          data.tenant_id,
          referenceDate,
          data.cycle_type,
          sequence,
          data.source_cycle_id ?? null,
          data.calculation_method ?? null,
          JSON.stringify(configuration),
          specialResults.length,
          totals.items,
          Number(totals.earnings.toFixed(2)),
          Number(totals.deductions.toFixed(2)),
          Number((totals.earnings - totals.deductions).toFixed(2)),
          context.userId,
        ],
      );

      if (data.cycle_type === "complementar") {
        for (const item of data.adjustments) {
          await client.query(
            `insert into public.payroll_special_adjustments
               (tenant_id,cycle_id,employment_link_id,nature,amount,reason,created_by)
             values ($1,$2,$3,$4,$5,$6,$7)`,
            [
              data.tenant_id,
              cycleId,
              item.employment_link_id,
              item.nature,
              item.amount,
              item.reason,
              context.userId,
            ],
          );
        }
      }
      for (const result of specialResults) {
        const net = Number((result.earnings - result.deductions).toFixed(2));
        const digest = checksum({
          cycle_id: cycleId,
          link_id: result.linkId,
          earnings: result.earnings,
          deductions: result.deductions,
          net,
          memory: result.memory,
        });
        await client.query(
          `insert into public.payroll_cycle_results
             (tenant_id,cycle_id,employment_link_id,earnings,deductions,
              net_amount,items_count,calculation_memory,result_checksum)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            data.tenant_id,
            cycleId,
            result.linkId,
            result.earnings,
            result.deductions,
            net,
            result.items,
            JSON.stringify(result.memory),
            digest,
          ],
        );
      }
      await client.query(
        `insert into public.payroll_cycle_events
           (tenant_id,cycle_id,from_status,to_status,actor_id,payload)
         values ($1,$2,null,'previa',$3,$4::jsonb)`,
        [
          data.tenant_id,
          cycleId,
          context.userId,
          JSON.stringify({
            cycle_type: data.cycle_type,
            sequence,
            configuration,
            links: specialResults.length,
            ...totals,
          }),
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "create_special_payroll",
        resource: "payroll_cycles",
        recordId: cycleId,
        after: {
          reference_month: referenceDate,
          cycle_type: data.cycle_type,
          sequence,
          links: specialResults.length,
          ...totals,
        },
      });
      return { cycleId, sequence, links: specialResults.length, ...totals };
    });
  });
