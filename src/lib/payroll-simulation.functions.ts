import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit, recordAuditQ } from "./audit.server";
import {
  loadTenantAccess,
  loadTenantUnitScope,
  requireTenantPermission,
  requireUnitInScope,
} from "./tenant-access.server";
import { checksumFormulaAst } from "./payroll-formula.server";
import { loadFiscalTables } from "./fiscal-tables.server";
import {
  evaluateFormulaAst,
  type PayrollFormulaVariable,
  type PayrollRoundingMode,
} from "./payroll-formula";

const ENGINE_VERSION = "ast-v1.0.0";
const TenantInput = z.object({ tenant_id: z.string().uuid() });

function checksum(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export const getPayrollSimulationWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    const canReadAssignments = access.permissions.includes(
      "payroll.assignments.read",
    );
    const canSimulate = access.permissions.includes("payroll.simulate");
    if (!canReadAssignments && !canSimulate)
      throw new Error("Sem permissão para eventos fixos ou simulações");

    const [links, rubrics, assignments, runs] = await Promise.all([
      query<{
        id: string;
        registration_number: string;
        full_name: string;
        base_salary: number | null;
        status: string;
        unit_id: string | null;
      }>(
        `select link.id,link.registration_number,person.full_name,link.base_salary,
           link.status,link.unit_id
         from public.employment_links link
         join public.persons person on person.id=link.person_id
         where link.tenant_id=$1 and link.status<>'desligado'
         order by person.full_name,link.registration_number`,
        [data.tenant_id],
      ),
      query<{
        id: string;
        code: string;
        name: string;
        nature: "provento" | "desconto" | "informativa";
        unit: string;
        calculation_order: number;
      }>(
        `select id,code,name,nature,unit,calculation_order
         from public.payroll_rubrics
         where tenant_id=$1 and status='ativo'
         order by calculation_order,code`,
        [data.tenant_id],
      ),
      canReadAssignments
        ? query<{
            id: string;
            employment_link_id: string;
            rubric_id: string;
            valid_from: string;
            valid_to: string | null;
            fixed_amount: number | null;
            quantity: number | null;
            parameters: Record<string, number>;
            status: "ativo" | "inativo";
            notes: string | null;
          }>(
            `select id,employment_link_id,rubric_id,valid_from::text,valid_to::text,
               fixed_amount,quantity,parameters,status,notes
             from public.employment_link_rubrics where tenant_id=$1
             order by valid_from desc,created_at desc`,
            [data.tenant_id],
          )
        : Promise.resolve([]),
      canSimulate
        ? query<{
            id: string;
            reference_month: string;
            status: "processando" | "concluida" | "falhou";
            engine_version: string;
            links_requested: number;
            links_processed: number;
            started_at: string;
            completed_at: string | null;
            error_message: string | null;
          }>(
            `select id,reference_month::text,status,engine_version,
               links_requested,links_processed,started_at::text,completed_at::text,error_message
             from public.payroll_calculation_runs where tenant_id=$1
             order by started_at desc limit 30`,
            [data.tenant_id],
          )
        : Promise.resolve([]),
    ]);

    return {
      links,
      rubrics,
      assignments,
      runs,
      canManageAssignments: access.permissions.includes(
        "payroll.assignments.manage",
      ),
      canSimulate,
    };
  });

const SaveAssignmentInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  rubric_id: z.string().uuid(),
  valid_from: z.string().date(),
  valid_to: z.string().date().nullable().optional(),
  fixed_amount: z.number().min(0).max(1_000_000_000).nullable().optional(),
  quantity: z.number().min(0).max(1_000_000_000).nullable().optional(),
  parameters: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
      z.number().finite().min(-1_000_000_000).max(1_000_000_000),
    )
    .default({}),
  status: z.enum(["ativo", "inativo"]).default("ativo"),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const saveEmploymentLinkRubric = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveAssignmentInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    const scope = await loadTenantUnitScope(
      access,
      "payroll.assignments.manage",
    );
    if (data.valid_to && data.valid_to < data.valid_from)
      throw new Error("A vigência final não pode anteceder a inicial");
    if (
      data.fixed_amount == null &&
      data.quantity == null &&
      Object.keys(data.parameters).length === 0
    )
      throw new Error("Informe valor, quantidade ou ao menos um parâmetro");

    const link = await queryOne<{ id: string; unit_id: string | null }>(
      `select id,unit_id from public.employment_links
       where id=$1 and tenant_id=$2`,
      [data.employment_link_id, data.tenant_id],
    );
    if (!link) throw new Error("Vínculo inválido para esta entidade");
    requireUnitInScope(scope, link.unit_id);
    const rubric = await queryOne<{ id: string }>(
      `select id from public.payroll_rubrics
       where id=$1 and tenant_id=$2 and status='ativo'`,
      [data.rubric_id, data.tenant_id],
    );
    if (!rubric) throw new Error("Rubrica ativa não encontrada");
    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          `select * from public.employment_link_rubrics
           where id=$1 and tenant_id=$2`,
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Atribuição não encontrada");
    const id = data.id ?? randomUUID();

    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.employment_link_rubrics set
             employment_link_id=$3,rubric_id=$4,valid_from=$5,valid_to=$6,
             fixed_amount=$7,quantity=$8,parameters=$9::jsonb,status=$10,notes=$11
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.employment_link_id,
            data.rubric_id,
            data.valid_from,
            data.valid_to || null,
            data.fixed_amount ?? null,
            data.quantity ?? null,
            JSON.stringify(data.parameters),
            data.status,
            data.notes || null,
          ],
        );
      } else {
        await client.query(
          `insert into public.employment_link_rubrics
             (id,tenant_id,employment_link_id,rubric_id,valid_from,valid_to,
              fixed_amount,quantity,parameters,status,notes,created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
          [
            id,
            data.tenant_id,
            data.employment_link_id,
            data.rubric_id,
            data.valid_from,
            data.valid_to || null,
            data.fixed_amount ?? null,
            data.quantity ?? null,
            JSON.stringify(data.parameters),
            data.status,
            data.notes || null,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "employment_link_rubrics",
        recordId: id,
        before: before ?? null,
        after: data,
      });
    });
    return { id };
  });

const RunInput = z.object({
  tenant_id: z.string().uuid(),
  reference_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  employment_link_ids: z.array(z.string().uuid()).min(1).max(500),
});

type CalculationSource = {
  assignment_id: string;
  employment_link_id: string;
  rubric_id: string;
  rubric_code: string;
  rubric_name: string;
  nature: "provento" | "desconto" | "informativa";
  calculation_order: number;
  base_salary: number | null;
  fixed_amount: number | null;
  quantity: number | null;
  parameters: Record<string, number>;
  version_id: string;
  version_number: number;
  formula_ast: unknown;
  formula_checksum: string;
  rounding_scale: number;
  rounding_mode: PayrollRoundingMode;
};

export const runPayrollSimulation = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => RunInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.simulate");
    const scope = await loadTenantUnitScope(access, "payroll.simulate");
    const linkIds = [...new Set(data.employment_link_ids)];
    const referenceDate = `${data.reference_month}-01`;
    const links = await query<{
      id: string;
      unit_id: string | null;
      registration_number: string;
      full_name: string;
      base_salary: number | null;
    }>(
      `select link.id,link.unit_id,link.registration_number,person.full_name,link.base_salary
       from public.employment_links link
       join public.persons person on person.id=link.person_id
       where link.tenant_id=$1 and link.id=any($2::uuid[]) and link.status<>'desligado'
       order by link.id`,
      [data.tenant_id, linkIds],
    );
    if (links.length !== linkIds.length)
      throw new Error("Há vínculo inválido ou desligado na seleção");
    links.forEach((link) => requireUnitInScope(scope, link.unit_id));

    const assignmentSources = await query<CalculationSource>(
      `select assignment.id as assignment_id,assignment.employment_link_id,
         rubric.id as rubric_id,rubric.code as rubric_code,rubric.name as rubric_name,
         rubric.nature,rubric.calculation_order,link.base_salary,
         assignment.fixed_amount,assignment.quantity,assignment.parameters,
         version.id as version_id,version.version_number,version.formula_ast,
         version.formula_checksum,version.rounding_scale,version.rounding_mode
       from public.employment_link_rubrics assignment
       join public.employment_links link on link.id=assignment.employment_link_id
       join public.payroll_rubrics rubric on rubric.id=assignment.rubric_id
       join public.payroll_rubric_versions version on version.rubric_id=rubric.id
         and version.tenant_id=assignment.tenant_id and version.status='publicada'
         and version.valid_from<=$3::date
         and (version.valid_to is null or version.valid_to>=$3::date)
       where assignment.tenant_id=$1
         and assignment.employment_link_id=any($2::uuid[])
         and assignment.status='ativo' and assignment.valid_from<=$3::date
         and (assignment.valid_to is null or assignment.valid_to>=$3::date)
         and rubric.status='ativo'
       order by assignment.employment_link_id,rubric.calculation_order,rubric.code`,
      [data.tenant_id, linkIds, referenceDate],
    );

    // Rubricas do REGIME (O1-02c): declaradas uma vez por regime, aplicam-se a
    // todo vinculo daquele regime. Sem linha de assignment, entao fixed_amount/
    // quantity nulos e parameters vazio; a formula (ex.: table_lookup contra a
    // tabela RPPS do ente) faz o calculo. Ver ADR 0003.
    const regimeSources = await query<CalculationSource>(
      `select prr.id as assignment_id,link.id as employment_link_id,
         rubric.id as rubric_id,rubric.code as rubric_code,rubric.name as rubric_name,
         rubric.nature,rubric.calculation_order,link.base_salary,
         null::numeric as fixed_amount,null::numeric as quantity,'{}'::jsonb as parameters,
         version.id as version_id,version.version_number,version.formula_ast,
         version.formula_checksum,version.rounding_scale,version.rounding_mode
       from public.pension_regime_rubrics prr
       join public.employment_links link on link.pension_regime_id=prr.pension_regime_id
         and link.tenant_id=prr.tenant_id
       join public.payroll_rubrics rubric on rubric.id=prr.rubric_id
       join public.payroll_rubric_versions version on version.rubric_id=rubric.id
         and version.tenant_id=prr.tenant_id and version.status='publicada'
         and version.valid_from<=$3::date
         and (version.valid_to is null or version.valid_to>=$3::date)
       where prr.tenant_id=$1 and link.id=any($2::uuid[]) and rubric.status='ativo'
       order by link.id,rubric.calculation_order,rubric.code`,
      [data.tenant_id, linkIds, referenceDate],
    );

    // A atribuicao explicita por vinculo tem precedencia: uma rubrica ja atribuida
    // ao vinculo nao e reaplicada pela regra do regime (evita dupla contagem).
    const assignedKey = new Set(
      assignmentSources.map((s) => `${s.employment_link_id}:${s.rubric_id}`),
    );
    const sources = [
      ...assignmentSources,
      ...regimeSources.filter(
        (s) => !assignedKey.has(`${s.employment_link_id}:${s.rubric_id}`),
      ),
    ];

    const incidenceRows = await query<{
      version_id: string;
      base_code: string | null;
      depends_on_rubric_id: string | null;
      factor: number;
    }>(
      `select version_id,base_code,depends_on_rubric_id,factor
       from public.payroll_rubric_incidences
       where tenant_id=$1 and active and version_id=any($2::uuid[])`,
      [data.tenant_id, sources.map((source) => source.version_id)],
    );

    const snapshot = {
      tenant_id: data.tenant_id,
      reference_month: referenceDate,
      engine_version: ENGINE_VERSION,
      links: links.map((link) => ({
        id: link.id,
        registration_number: link.registration_number,
        base_salary: Number(link.base_salary ?? 0),
      })),
      assignments: sources.map((source) => ({
        assignment_id: source.assignment_id,
        rubric_id: source.rubric_id,
        version_id: source.version_id,
        formula_checksum: source.formula_checksum,
        fixed_amount: source.fixed_amount,
        quantity: source.quantity,
        parameters: source.parameters,
      })),
    };
    const runId = randomUUID();
    await query(
      `insert into public.payroll_calculation_runs
         (id,tenant_id,reference_month,engine_version,input_snapshot,input_checksum,
          links_requested,started_by)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [
        runId,
        data.tenant_id,
        referenceDate,
        ENGINE_VERSION,
        JSON.stringify(snapshot),
        checksum(snapshot),
        links.length,
        context.userId,
      ],
    );

    try {
      // Tabelas fiscais vigentes na competência, pré-carregadas uma vez e
      // passadas ao avaliador puro (nós table_lookup consultam este Map, sem
      // I/O dentro do avaliador). Ver O1-01 / ADR 0003.
      const fiscalTables = await loadFiscalTables(
        data.tenant_id,
        referenceDate,
      );

      const items: Array<{
        id: string;
        linkId: string;
        rubricId: string;
        versionId: string;
        sequence: number;
        quantity: number | null;
        calculationBase: number;
        amount: number;
        formulaChecksum: string;
        memory: Record<string, unknown>;
      }> = [];

      for (const link of links) {
        const linkSources = sources.filter(
          (source) => source.employment_link_id === link.id,
        );
        const pending = [...linkSources];
        const calculated = new Map<string, number>();
        const bases: Record<string, number> = {
          inss: 0,
          irrf: 0,
          fgts: 0,
          patronal: 0,
        };
        let sequence = 0;
        while (pending.length) {
          const index = pending.findIndex((source) => {
            const dependencies = incidenceRows
              .filter(
                (row) =>
                  row.version_id === source.version_id &&
                  row.depends_on_rubric_id,
              )
              .map((row) => row.depends_on_rubric_id!);
            return dependencies.every(
              (id) =>
                calculated.has(id) ||
                !linkSources.some((candidate) => candidate.rubric_id === id),
            );
          });
          if (index < 0)
            throw new Error(
              `Dependência circular detectada no vínculo ${link.registration_number}`,
            );
          const source = pending.splice(index, 1)[0];
          const verified = checksumFormulaAst(source.formula_ast);
          if (verified.checksum !== source.formula_checksum)
            throw new Error(
              `Checksum divergente na rubrica ${source.rubric_code}`,
            );
          const dependencies = incidenceRows.filter(
            (row) =>
              row.version_id === source.version_id && row.depends_on_rubric_id,
          );
          const dependencyTotal = dependencies.reduce(
            (total, row) =>
              total +
              Number(calculated.get(row.depends_on_rubric_id!) ?? 0) *
                (Number(row.factor) / 100),
            0,
          );
          const parameters = source.parameters ?? {};
          const variables: Partial<Record<PayrollFormulaVariable, number>> = {
            salary_base: Number(source.base_salary ?? 0),
            fixed_amount: Number(source.fixed_amount ?? 0),
            quantity: Number(source.quantity ?? 0),
            hours: Number(parameters.hours ?? source.quantity ?? 0),
            days: Number(parameters.days ?? source.quantity ?? 0),
            dependency_total: dependencyTotal,
            inss_base: bases.inss,
            irrf_base: bases.irrf,
            fgts_base: bases.fgts,
            patronal_base: bases.patronal,
            dependents_ir: Number(parameters.dependents_ir ?? 0),
          };
          const basesBefore = { ...bases };
          const evaluation = evaluateFormulaAst(
            verified.ast,
            variables,
            fiscalTables,
            Number(source.rounding_scale),
            source.rounding_mode,
          );
          const amount = evaluation.roundedValue;
          calculated.set(source.rubric_id, amount);
          incidenceRows
            .filter(
              (row) => row.version_id === source.version_id && row.base_code,
            )
            .forEach((row) => {
              bases[row.base_code!] += amount * (Number(row.factor) / 100);
            });
          sequence += 1;
          items.push({
            id: randomUUID(),
            linkId: link.id,
            rubricId: source.rubric_id,
            versionId: source.version_id,
            sequence,
            quantity: source.quantity == null ? null : Number(source.quantity),
            calculationBase:
              dependencyTotal ||
              Number(source.fixed_amount ?? source.base_salary ?? 0),
            amount,
            formulaChecksum: verified.checksum,
            memory: {
              engine_version: ENGINE_VERSION,
              rubric: {
                code: source.rubric_code,
                name: source.rubric_name,
                nature: source.nature,
                version: source.version_number,
              },
              assignment_id: source.assignment_id,
              variables,
              formula_ast: verified.ast,
              formula_checksum: verified.checksum,
              operations: evaluation.steps,
              raw_value: evaluation.rawValue,
              rounding: evaluation.rounding,
              final_value: amount,
              bases_before: basesBefore,
              bases_after: { ...bases },
            },
          });
        }
      }

      await withTransaction(async (client) => {
        for (const item of items) {
          await client.query(
            `insert into public.payroll_calculation_items
               (id,tenant_id,run_id,employment_link_id,rubric_id,version_id,
                sequence,quantity,calculation_base,amount,formula_checksum,memory)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
            [
              item.id,
              data.tenant_id,
              runId,
              item.linkId,
              item.rubricId,
              item.versionId,
              item.sequence,
              item.quantity,
              item.calculationBase,
              item.amount,
              item.formulaChecksum,
              JSON.stringify(item.memory),
            ],
          );
        }
        await client.query(
          `update public.payroll_calculation_runs set status='concluida',
             links_processed=$2,completed_at=now() where id=$1`,
          [runId, links.length],
        );
      });
      await recordAuditQ({
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "simulate",
        resource: "payroll_calculation_runs",
        recordId: runId,
        after: {
          reference_month: referenceDate,
          links: links.length,
          items: items.length,
          input_checksum: checksum(snapshot),
        },
      });
      return {
        runId,
        linksProcessed: links.length,
        itemsCalculated: items.length,
      };
    } catch (error) {
      await query(
        `update public.payroll_calculation_runs set status='falhou',
           error_message=$2,completed_at=now() where id=$1`,
        [
          runId,
          error instanceof Error ? error.message.slice(0, 1000) : "Falha",
        ],
      );
      throw error;
    }
  });

const RunDetailInput = z.object({
  tenant_id: z.string().uuid(),
  run_id: z.string().uuid(),
});

export const getPayrollSimulationRun = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => RunDetailInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.simulate");
    const run = await queryOne<Record<string, unknown>>(
      `select id,reference_month::text,status,engine_version,input_checksum,
         links_requested,links_processed,error_message,started_at::text,completed_at::text
       from public.payroll_calculation_runs where id=$1 and tenant_id=$2`,
      [data.run_id, data.tenant_id],
    );
    if (!run) throw new Error("Simulação não encontrada");
    const items = await query<{
      id: string;
      employment_link_id: string;
      registration_number: string;
      full_name: string;
      rubric_code: string;
      rubric_name: string;
      nature: "provento" | "desconto" | "informativa";
      sequence: number;
      amount: number;
      calculation_base: number;
      quantity: number | null;
      memory: Record<string, unknown>;
    }>(
      `select item.id,item.employment_link_id,link.registration_number,
         person.full_name,rubric.code as rubric_code,rubric.name as rubric_name,
         rubric.nature,item.sequence,item.amount,item.calculation_base,item.quantity,item.memory
       from public.payroll_calculation_items item
       join public.employment_links link on link.id=item.employment_link_id
       join public.persons person on person.id=link.person_id
       join public.payroll_rubrics rubric on rubric.id=item.rubric_id
       where item.run_id=$1 and item.tenant_id=$2
       order by person.full_name,item.sequence`,
      [data.run_id, data.tenant_id],
    );
    return { run, items };
  });
