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
import { checksumFormulaAst } from "./payroll-formula.server";
import { evaluateFormulaAst } from "./payroll-formula";

const TenantInput = z.object({ tenant_id: z.string().uuid() });

export const getPayrollCatalog = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.catalog.read");
    const [rubrics, versions, incidences] = await Promise.all([
      query<{
        id: string;
        code: string;
        name: string;
        nature: "provento" | "desconto" | "informativa";
        unit: "valor" | "percentual" | "hora" | "dia" | "quantidade";
        calculation_order: number;
        status: "rascunho" | "ativo" | "inativo";
        description: string | null;
      }>(
        `select id,code,name,nature,unit,calculation_order,status,description
         from public.payroll_rubrics where tenant_id=$1
         order by calculation_order,code`,
        [data.tenant_id],
      ),
      query<{
        id: string;
        rubric_id: string;
        version_number: number;
        valid_from: string;
        valid_to: string | null;
        status: "rascunho" | "publicada" | "arquivada";
        rounding_scale: number;
        rounding_mode: string;
        notes: string | null;
        published_at: string | null;
        formula_ast: unknown | null;
        formula_checksum: string | null;
      }>(
        `select id,rubric_id,version_number,valid_from::text,valid_to::text,
           status,rounding_scale,rounding_mode,notes,published_at::text,
           formula_ast,formula_checksum
         from public.payroll_rubric_versions where tenant_id=$1
         order by rubric_id,version_number desc`,
        [data.tenant_id],
      ),
      query<{
        id: string;
        version_id: string;
        base_code: string | null;
        depends_on_rubric_id: string | null;
        factor: number;
        active: boolean;
      }>(
        `select id,version_id,base_code,depends_on_rubric_id,factor,active
         from public.payroll_rubric_incidences where tenant_id=$1 and active
         order by version_id,base_code,depends_on_rubric_id`,
        [data.tenant_id],
      ),
    ]);
    return {
      rubrics,
      versions,
      incidences,
      canManage: access.permissions.includes("payroll.catalog.manage"),
    };
  });

const SaveRubricInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,40}$/),
  name: z.string().trim().min(2).max(160),
  nature: z.enum(["provento", "desconto", "informativa"]),
  unit: z.enum(["valor", "percentual", "hora", "dia", "quantidade"]),
  calculation_order: z.number().int().min(0).max(99999),
  status: z.enum(["rascunho", "ativo", "inativo"]),
  description: z.string().trim().max(500).nullable().optional(),
});

export const savePayrollRubric = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveRubricInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.catalog.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.payroll_rubrics
       where tenant_id=$1 and lower(code)=lower($2)
         and ($3::uuid is null or id<>$3)`,
      [data.tenant_id, data.code, data.id ?? null],
    );
    if (duplicate)
      throw new Error("Código de rubrica já utilizado nesta entidade");
    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          "select * from public.payroll_rubrics where id=$1 and tenant_id=$2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Rubrica não encontrada");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.payroll_rubrics set code=$3,name=$4,nature=$5,unit=$6,
             calculation_order=$7,status=$8,description=$9 where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.code.toUpperCase(),
            data.name,
            data.nature,
            data.unit,
            data.calculation_order,
            data.status,
            data.description || null,
          ],
        );
      } else {
        await client.query(
          `insert into public.payroll_rubrics
             (id,tenant_id,code,name,nature,unit,calculation_order,status,description,created_by)
           values ($1,$2,$3,$4,$5,$6,$7,'rascunho',$8,$9)`,
          [
            id,
            data.tenant_id,
            data.code.toUpperCase(),
            data.name,
            data.nature,
            data.unit,
            data.calculation_order,
            data.description || null,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "payroll_rubrics",
        recordId: id,
        before: before ?? null,
        after: data,
      });
    });
    return { id };
  });

const SaveVersionInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  rubric_id: z.string().uuid(),
  valid_from: z.string().date(),
  valid_to: z.string().date().nullable().optional(),
  status: z.enum(["rascunho", "publicada", "arquivada"]),
  rounding_scale: z.number().int().min(0).max(6),
  rounding_mode: z.enum(["half_up", "half_even", "truncate"]),
  notes: z.string().trim().max(1000).nullable().optional(),
  base_codes: z.array(z.enum(["inss", "irrf", "fgts", "patronal"])),
  dependencies: z.array(z.string().uuid()).max(100),
  formula_ast: z.unknown().nullable().optional(),
});

export const savePayrollRubricVersion = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveVersionInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.catalog.manage");
    if (data.valid_to && data.valid_to < data.valid_from)
      throw new Error("A vigência final não pode anteceder a inicial");
    const formula = data.formula_ast
      ? checksumFormulaAst(data.formula_ast)
      : null;
    if (data.status === "publicada" && !formula)
      throw new Error("Versão publicada exige fórmula validada");
    if (data.dependencies.includes(data.rubric_id))
      throw new Error("Uma rubrica não pode depender de si mesma");
    const rubric = await queryOne<{ id: string }>(
      "select id from public.payroll_rubrics where id=$1 and tenant_id=$2",
      [data.rubric_id, data.tenant_id],
    );
    if (!rubric) throw new Error("Rubrica inválida para esta entidade");
    if (data.dependencies.length) {
      const count = await queryOne<{ total: number }>(
        "select count(*)::int as total from public.payroll_rubrics where tenant_id=$1 and id=any($2::uuid[])",
        [data.tenant_id, data.dependencies],
      );
      if ((count?.total ?? 0) !== new Set(data.dependencies).size)
        throw new Error("Há dependência de rubrica inválida");
    }
    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          "select * from public.payroll_rubric_versions where id=$1 and tenant_id=$2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Versão não encontrada");
    if (before?.status === "publicada")
      throw new Error("Versão publicada é imutável; crie uma nova versão");
    const id = data.id ?? randomUUID();
    const number = data.id
      ? Number(before!.version_number)
      : Number(
          (
            await queryOne<{ next: number }>(
              "select coalesce(max(version_number),0)::int+1 as next from public.payroll_rubric_versions where rubric_id=$1",
              [data.rubric_id],
            )
          )?.next ?? 1,
        );
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.payroll_rubric_versions set valid_from=$3,valid_to=$4,
             status=$5,rounding_scale=$6,rounding_mode=$7,
             formula_ast=$8::jsonb,formula_checksum=$9,notes=$10,
             published_by=case when $5='publicada' then $11 else published_by end
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.valid_from,
            data.valid_to || null,
            data.status,
            data.rounding_scale,
            data.rounding_mode,
            formula ? JSON.stringify(formula.ast) : null,
            formula?.checksum ?? null,
            data.notes || null,
            context.userId,
          ],
        );
      } else {
        await client.query(
          `insert into public.payroll_rubric_versions
             (id,tenant_id,rubric_id,version_number,valid_from,valid_to,status,
              rounding_scale,rounding_mode,formula_ast,formula_checksum,notes,
              published_by,created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,
             case when $7='publicada' then $13 else null end,$13)`,
          [
            id,
            data.tenant_id,
            data.rubric_id,
            number,
            data.valid_from,
            data.valid_to || null,
            data.status,
            data.rounding_scale,
            data.rounding_mode,
            formula ? JSON.stringify(formula.ast) : null,
            formula?.checksum ?? null,
            data.notes || null,
            context.userId,
          ],
        );
      }
      await client.query(
        "delete from public.payroll_rubric_incidences where version_id=$1",
        [id],
      );
      for (const baseCode of new Set(data.base_codes)) {
        await client.query(
          `insert into public.payroll_rubric_incidences
             (tenant_id,version_id,base_code,factor,created_by)
           values ($1,$2,$3,100,$4)`,
          [data.tenant_id, id, baseCode, context.userId],
        );
      }
      for (const dependency of new Set(data.dependencies)) {
        await client.query(
          `insert into public.payroll_rubric_incidences
             (tenant_id,version_id,depends_on_rubric_id,factor,created_by)
           values ($1,$2,$3,100,$4)`,
          [data.tenant_id, id, dependency, context.userId],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "payroll_rubric_versions",
        recordId: id,
        before: before ?? null,
        after: { ...data, version_number: number },
      });
    });
    return {
      id,
      versionNumber: number,
      formulaChecksum: formula?.checksum ?? null,
    };
  });

const ValidateFormulaInput = z.object({
  tenant_id: z.string().uuid(),
  formula_ast: z.unknown(),
  rounding_scale: z.number().int().min(0).max(6).default(2),
  rounding_mode: z
    .enum(["half_up", "half_even", "truncate"])
    .default("half_up"),
  sample_variables: z.record(z.string(), z.number()).default({}),
});

export const validatePayrollFormula = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ValidateFormulaInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.catalog.manage");
    const formula = checksumFormulaAst(data.formula_ast);
    const evaluation = evaluateFormulaAst(
      formula.ast,
      data.sample_variables,
      // Preview do catálogo não injeta tabelas fiscais; uma fórmula com
      // table_lookup falha aqui de propósito (valide-a no ciclo).
      new Map(),
      data.rounding_scale,
      data.rounding_mode,
    );
    return { ...formula, evaluation };
  });

const ProjectBaseInput = z.object({
  tenant_id: z.string().uuid(),
  lines: z
    .array(z.object({ version_id: z.string().uuid(), amount: z.number() }))
    .max(500),
});

export const projectPayrollBases = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ProjectBaseInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.catalog.read");
    return queryOne<{ bases: Record<string, number> }>(
      "select public.payroll_project_bases($1,$2::jsonb) as bases",
      [data.tenant_id, JSON.stringify(data.lines)],
    ).then((row) => row?.bases ?? {});
  });
