// Catalogo de regimes previdenciarios do ente (O1-02b): RPPS (estatutarios) e RGPS
// (celetistas/INSS). Entidade de primeira classe que o vinculo referencia por
// employment_links.pension_regime_id. Espelha payroll-catalog/fiscal-tables:
// createServerFn + loadTenantAccess + requireTenantPermission, dedup por codigo,
// auditado. Reusa as permissoes people.read/people.manage.
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

export const getPensionRegimes = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TenantInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const regimes = await query<{
      id: string;
      code: string;
      name: string;
      regime_type: "rpps" | "rgps";
      status: "ativo" | "inativo";
      description: string | null;
    }>(
      `select id,code,name,regime_type,status,description
       from public.pension_regimes where tenant_id=$1
       order by lower(code)`,
      [data.tenant_id],
    );
    return {
      regimes,
      canManage: access.permissions.includes("people.manage"),
    };
  });

// Workspace da UI de previdencia (O1-02d): reune numa chamada os regimes do ente,
// o catalogo de rubricas ativas (para o multi-select) e o mapa regime -> rubricas.
// Espelha getSpecialPayrollWorkspace/getPayrollSimulationWorkspace. Leitura por
// people.read; os flags dizem o que a tela pode gerir.
export const getPensionWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TenantInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const [regimes, rubrics, regimeRubrics] = await Promise.all([
      query<{
        id: string;
        code: string;
        name: string;
        regime_type: "rpps" | "rgps";
        status: "ativo" | "inativo";
        description: string | null;
      }>(
        `select id,code,name,regime_type,status,description
         from public.pension_regimes where tenant_id=$1
         order by lower(code)`,
        [data.tenant_id],
      ),
      query<{
        id: string;
        code: string;
        name: string;
        nature: "provento" | "desconto" | "informativa";
      }>(
        `select id,code,name,nature from public.payroll_rubrics
         where tenant_id=$1 and status='ativo'
         order by calculation_order,code`,
        [data.tenant_id],
      ),
      query<{ pension_regime_id: string; rubric_id: string }>(
        `select pension_regime_id, rubric_id
         from public.pension_regime_rubrics where tenant_id=$1`,
        [data.tenant_id],
      ),
    ]);
    return {
      regimes,
      rubrics,
      regimeRubrics,
      canManageRegimes: access.permissions.includes("people.manage"),
      canManageRubrics: access.permissions.includes(
        "payroll.assignments.manage",
      ),
    };
  });

const SaveRegimeInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]{1,40}$/),
  name: z.string().trim().min(2).max(160),
  regime_type: z.enum(["rpps", "rgps"]),
  status: z.enum(["ativo", "inativo"]),
  description: z.string().trim().max(500).nullable().optional(),
});

export const savePensionRegime = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveRegimeInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.pension_regimes
       where tenant_id=$1 and lower(code)=lower($2)
         and ($3::uuid is null or id<>$3)`,
      [data.tenant_id, data.code, data.id ?? null],
    );
    if (duplicate)
      throw new Error("Código de regime já utilizado nesta entidade");
    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          "select * from public.pension_regimes where id=$1 and tenant_id=$2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Regime não encontrado");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.pension_regimes set code=$3,name=$4,regime_type=$5,
             status=$6,description=$7 where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.code,
            data.name,
            data.regime_type,
            data.status,
            data.description || null,
          ],
        );
      } else {
        await client.query(
          `insert into public.pension_regimes
             (id,tenant_id,code,name,regime_type,status,description,created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            data.tenant_id,
            data.code,
            data.name,
            data.regime_type,
            data.status,
            data.description || null,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "pension_regimes",
        recordId: id,
        before: before ?? null,
        after: data,
      });
    });
    return { id };
  });

// Mapeamento regime -> rubricas (O1-02c): as rubricas de contribuicao aplicadas
// automaticamente a todo vinculo do regime pelo ciclo.

export const getPensionRegimeRubrics = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TenantInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.simulate");
    return query<{
      pension_regime_id: string;
      rubric_id: string;
      rubric_code: string;
    }>(
      `select prr.pension_regime_id, prr.rubric_id, r.code as rubric_code
       from public.pension_regime_rubrics prr
       join public.payroll_rubrics r on r.id = prr.rubric_id
       where prr.tenant_id=$1
       order by prr.pension_regime_id, r.calculation_order, r.code`,
      [data.tenant_id],
    );
  });

const SetRegimeRubricsInput = z.object({
  tenant_id: z.string().uuid(),
  pension_regime_id: z.string().uuid(),
  rubric_ids: z.array(z.string().uuid()).max(200),
});

export const setPensionRegimeRubrics = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SetRegimeRubricsInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "payroll.assignments.manage");
    const regime = await queryOne<{ id: string }>(
      "select id from public.pension_regimes where id=$1 and tenant_id=$2",
      [data.pension_regime_id, data.tenant_id],
    );
    if (!regime) throw new Error("Regime inválido para esta entidade");
    const ids = [...new Set(data.rubric_ids)];
    if (ids.length) {
      const count = await queryOne<{ total: number }>(
        "select count(*)::int as total from public.payroll_rubrics where tenant_id=$1 and id=any($2::uuid[])",
        [data.tenant_id, ids],
      );
      if ((count?.total ?? 0) !== ids.length)
        throw new Error("Há rubrica inválida para esta entidade");
    }
    await withTransaction(async (client) => {
      await client.query(
        "delete from public.pension_regime_rubrics where tenant_id=$1 and pension_regime_id=$2",
        [data.tenant_id, data.pension_regime_id],
      );
      for (const rubricId of ids) {
        await client.query(
          `insert into public.pension_regime_rubrics
             (tenant_id, pension_regime_id, rubric_id, created_by)
           values ($1,$2,$3,$4)`,
          [data.tenant_id, data.pension_regime_id, rubricId, context.userId],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "update",
        resource: "pension_regime_rubrics",
        recordId: data.pension_regime_id,
        before: null,
        after: { pension_regime_id: data.pension_regime_id, rubric_ids: ids },
      });
    });
    return { count: ids.length };
  });
