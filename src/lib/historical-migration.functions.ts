import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, queryOne } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAuditQ } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
const row = z.object({
  source_key: z.string().min(1).max(200),
  reference_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().finite(),
  payload: z.record(z.string(), z.unknown()),
});
export const createMigrationJob = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        name: z.string().min(3).max(160),
        source_type: z.string().min(2).max(80),
        expected_rows: z.number().int().nonnegative(),
        expected_total: z.number().finite(),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "migration.manage");
    return (
      await query<{ id: string }>(
        `insert into public.historical_migration_jobs(tenant_id,name,source_type,expected_rows,expected_total,created_by) values($1,$2,$3,$4,$5,$6) returning id`,
        [
          data.tenant_id,
          data.name,
          data.source_type,
          data.expected_rows,
          data.expected_total,
          context.userId,
        ],
      )
    )[0];
  });
export const stageHistoricalRows = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({
        tenant_id: z.string().uuid(),
        job_id: z.string().uuid(),
        rows: z.array(row).min(1).max(5000),
      })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "migration.manage");
    const job = await queryOne<any>(
      `select id from public.historical_migration_jobs where id=$1 and tenant_id=$2 and status in('draft','staged')`,
      [data.job_id, data.tenant_id],
    );
    if (!job) throw Error("Lote inexistente ou já fechado");
    for (const r of data.rows) {
      const d = new Date(`${r.reference_date}T00:00:00Z`),
        min = new Date();
      min.setUTCFullYear(min.getUTCFullYear() - 15);
      const errors: string[] = [];
      if (Number.isNaN(d.valueOf())) errors.push("data_invalida");
      if (d > new Date()) errors.push("data_futura");
      if (d < min) errors.push("fora_da_janela_de_15_anos");
      await query(
        `insert into public.historical_migration_rows(job_id,tenant_id,source_key,reference_date,amount,payload,row_status,validation_errors) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(job_id,source_key) do update set reference_date=excluded.reference_date,amount=excluded.amount,payload=excluded.payload,row_status=excluded.row_status,validation_errors=excluded.validation_errors`,
        [
          data.job_id,
          data.tenant_id,
          r.source_key,
          r.reference_date,
          r.amount,
          JSON.stringify(r.payload),
          errors.length ? "invalid" : "valid",
          errors,
        ],
      );
    }
    await query(
      `update public.historical_migration_jobs set status='staged' where id=$1`,
      [data.job_id],
    );
    return { staged: data.rows.length };
  });
export const reconcileMigrationJob = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({ tenant_id: z.string().uuid(), job_id: z.string().uuid() })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "migration.manage");
    const s = await queryOne<any>(
      `select j.expected_rows,j.expected_total,count(r.*)::bigint staged_rows,count(r.*)filter(where r.row_status='valid')::bigint valid_rows,coalesce(sum(r.amount)filter(where r.row_status='valid'),0) staged_total,count(r.*)filter(where r.row_status='invalid')::bigint invalid_rows from public.historical_migration_jobs j left join public.historical_migration_rows r on r.job_id=j.id where j.id=$1 and j.tenant_id=$2 group by j.id`,
      [data.job_id, data.tenant_id],
    );
    if (!s) throw Error("Lote inexistente");
    const reconciled =
      Number(s.expected_rows) === Number(s.valid_rows) &&
      Number(s.expected_total) === Number(s.staged_total) &&
      Number(s.invalid_rows) === 0;
    await query(
      `update public.historical_migration_jobs set staged_rows=$2,valid_rows=$3,staged_total=$4,status=$5,checksum=md5($2::text||':'||$4::text) where id=$1`,
      [
        data.job_id,
        s.staged_rows,
        s.valid_rows,
        s.staged_total,
        reconciled ? "reconciled" : "staged",
      ],
    );
    return {
      ...s,
      reconciled,
      rowDifference: Number(s.valid_rows) - Number(s.expected_rows),
      totalDifference: Number(s.staged_total) - Number(s.expected_total),
    };
  });
export const commitMigrationJob = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z
      .object({ tenant_id: z.string().uuid(), job_id: z.string().uuid() })
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "migration.manage");
    const job = await queryOne<any>(
      `select * from public.historical_migration_jobs where id=$1 and tenant_id=$2 and status='reconciled'`,
      [data.job_id, data.tenant_id],
    );
    if (!job) throw Error("Reconciliação obrigatória antes do fechamento");
    await query(
      `insert into public.historical_records(tenant_id,job_id,source_type,source_key,reference_date,amount,payload) select r.tenant_id,r.job_id,$2,r.source_key,r.reference_date,r.amount,r.payload from public.historical_migration_rows r where r.job_id=$1 and r.row_status='valid' on conflict(tenant_id,source_type,source_key) do update set reference_date=excluded.reference_date,amount=excluded.amount,payload=excluded.payload,imported_at=now()`,
      [data.job_id, job.source_type],
    );
    await query(
      `update public.historical_migration_jobs set status='committed',committed_at=now() where id=$1`,
      [data.job_id],
    );
    // Trilha de auditoria do ato de ingestão de dados (fechamento da migração).
    await recordAuditQ({
      tenantId: data.tenant_id,
      actorId: context.userId,
      action: "migracao.fechar",
      resource: "historical_migration_jobs",
      recordId: data.job_id,
      after: {
        source_type: job.source_type,
        committed_rows: Number(job.valid_rows),
      },
    });
    return { committed: Number(job.valid_rows), archiveOnly: true };
  });
export const listMigrationJobs = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z.object({ tenant_id: z.string().uuid() }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "migration.read");
    return query<any>(
      `select * from public.historical_migration_jobs where tenant_id=$1 order by created_at desc limit 50`,
      [data.tenant_id],
    );
  });
