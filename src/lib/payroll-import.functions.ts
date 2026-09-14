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
const Row = z.object({
  matricula: z.string(),
  rubrica: z.string(),
  valor: z.union([z.string(), z.number()]),
  parcelas: z.union([z.string(), z.number()]).optional(),
});
const Input = z.object({
  tenant_id: z.string().uuid(),
  file_name: z.string(),
  file_type: z.enum(["txt", "csv", "xlsx"]),
  reference_month: z.string().regex(/^\d{4}-\d{2}$/),
  rows: z.array(Row).max(10000),
});
export const stagePayrollImport = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => parseInput(Input, v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "payroll.import.manage");
    return withTransaction(async (c) => {
      const id = randomUUID(),
        hash = createHash("sha256")
          .update(JSON.stringify(data.rows))
          .digest("hex");
      await c.query(
        `insert into public.payroll_import_batches(id,tenant_id,file_name,file_type,reference_month,total_rows,file_sha256,created_by)values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          data.tenant_id,
          data.file_name,
          data.file_type,
          data.reference_month + "-01",
          data.rows.length,
          hash,
          context.userId,
        ],
      );
      let valid = 0;
      for (let i = 0; i < data.rows.length; i++) {
        const r = data.rows[i],
          amount = Number(String(r.valor).replace(",", ".")),
          installments = Number(r.parcelas || 1);
        const link = (
          await c.query<any>(
            `select id from public.employment_links where tenant_id=$1 and registration_number=$2`,
            [data.tenant_id, r.matricula],
          )
        ).rows[0];
        const rubric = (
          await c.query<any>(
            `select id from public.payroll_rubrics where tenant_id=$1 and upper(code)=upper($2) and status='ativo'`,
            [data.tenant_id, r.rubrica],
          )
        ).rows[0];
        const errors = [];
        if (!link) errors.push("MATRICULA_NAO_ENCONTRADA");
        if (!rubric) errors.push("RUBRICA_NAO_ENCONTRADA");
        if (!Number.isFinite(amount) || amount < 0)
          errors.push("VALOR_INVALIDO");
        if (
          !Number.isInteger(installments) ||
          installments < 1 ||
          installments > 120
        )
          errors.push("PARCELAS_INVALIDAS");
        if (!errors.length) valid++;
        await c.query(
          `insert into public.payroll_import_rows(tenant_id,batch_id,row_number,raw_data,employment_link_id,rubric_id,amount,installments,error_codes,status)values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10)`,
          [
            data.tenant_id,
            id,
            i + 2,
            JSON.stringify(r),
            link?.id,
            rubric?.id,
            Number.isFinite(amount) ? amount : null,
            installments,
            JSON.stringify(errors),
            errors.length ? "invalida" : "valida",
          ],
        );
      }
      await c.query(
        `update public.payroll_import_batches set status=$2,valid_rows=$3,error_rows=$4 where id=$1`,
        [
          id,
          valid === data.rows.length ? "pre_validado" : "com_erros",
          valid,
          data.rows.length - valid,
        ],
      );
      return { batchId: id, valid, error: data.rows.length - valid };
    });
  });
export const commitPayrollImport = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    parseInput(
      z.object({ tenant_id: z.string().uuid(), batch_id: z.string().uuid() }),
      v,
    ),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "payroll.import.manage");
    return withTransaction(async (c) => {
      const b = (
        await c.query<any>(
          `select * from public.payroll_import_batches where id=$1 and tenant_id=$2 and status='pre_validado' for update`,
          [data.batch_id, data.tenant_id],
        )
      ).rows[0];
      if (!b) throw new Error("Lote com erros ou já importado");
      const rows = (
        await c.query<any>(
          `select * from public.payroll_import_rows where batch_id=$1 and status='valida' order by row_number`,
          [b.id],
        )
      ).rows;
      for (const r of rows)
        for (let n = 1; n <= r.installments; n++) {
          const d = new Date(b.reference_month);
          d.setUTCMonth(d.getUTCMonth() + n - 1);
          await c.query(
            `insert into public.payroll_monthly_variables(tenant_id,employment_link_id,rubric_id,reference_month,amount,installment_number,installments_total,source_batch_id)values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              data.tenant_id,
              r.employment_link_id,
              r.rubric_id,
              d.toISOString().slice(0, 10),
              r.amount,
              n,
              r.installments,
              b.id,
            ],
          );
        }
      await c.query(
        "update public.payroll_import_rows set status='importada' where batch_id=$1",
        [b.id],
      );
      await c.query(
        "update public.payroll_import_batches set status='importado',committed_at=now() where id=$1",
        [b.id],
      );
      return { imported: rows.length };
    });
  });
export const getPayrollImports = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    parseInput(z.object({ tenant_id: z.string().uuid() }), v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "payroll.import.read");
    return {
      batches: await query<any>(
        `select * from public.payroll_import_batches where tenant_id=$1 order by created_at desc`,
        [data.tenant_id],
      ),
      rows: await query<any>(
        `select * from public.payroll_import_rows where tenant_id=$1 order by batch_id,row_number`,
        [data.tenant_id],
      ),
      canManage: a.permissions.includes("payroll.import.manage"),
    };
  });
