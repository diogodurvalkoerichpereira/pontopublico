import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
const Input = z.object({
  tenant_id: z.string().uuid(),
  cycle_id: z.string().uuid(),
  bank_code: z.string().regex(/^\d{3}$/),
});
const pad = (v: unknown, n: number) =>
  String(v ?? "")
    .replace(/\D/g, "")
    .padStart(n, "0")
    .slice(-n);
export const generateBankRemittance = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => Input.parse(v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "bank.remittance.manage");
    return withTransaction(async (c) => {
      const cycle = (
        await c.query<any>(
          `select * from public.payroll_cycles where id=$1 and tenant_id=$2 and status='fechada' for update`,
          [data.cycle_id, data.tenant_id],
        )
      ).rows[0];
      if (!cycle) throw new Error("Folha deve estar fechada");
      const rows = (
        await c.query<any>(
          `select r.net_amount,a.*,p.cpf from public.payroll_cycle_results r join public.payroll_bank_accounts a on a.employment_link_id=r.employment_link_id and a.active join public.employment_links l on l.id=r.employment_link_id join public.persons p on p.id=l.person_id where r.cycle_id=$1 and a.bank_code=$2 order by l.registration_number`,
          [cycle.id, data.bank_code],
        )
      ).rows;
      if (rows.length !== cycle.links_count)
        throw new Error("Há vínculos sem conta bancária ativa");
      const detail = rows.map(
        (r: any, i: number) =>
          `3${pad(i + 1, 5)}${pad(r.holder_document || r.cpf, 14)}${pad(r.branch, 5)}${pad(r.account_number, 12)}${pad(Math.round(Number(r.net_amount) * 100), 15)}`,
      );
      const total = rows.reduce(
        (s: number, r: any) => s + Number(r.net_amount),
        0,
      );
      const content = [
        `0${data.bank_code}${pad(cycle.reference_month.replace(/-/g, ""), 8)}`,
        ...detail,
        `9${pad(rows.length, 6)}${pad(Math.round(total * 100), 18)}`,
      ].join("\r\n");
      const hash = createHash("sha256").update(content).digest("hex"),
        id = randomUUID();
      await c.query(
        `insert into public.bank_remittance_batches(id,tenant_id,payroll_cycle_id,bank_code,layout_version,records_count,total_amount,file_content,file_sha256,created_by)values($1,$2,$3,$4,'CNAB240-v1',$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          cycle.id,
          data.bank_code,
          rows.length,
          total,
          content,
          hash,
          context.userId,
        ],
      );
      return { id, content, hash, total };
    });
  });
export const getBankRemittances = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) =>
    z.object({ tenant_id: z.string().uuid() }).parse(v),
  )
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "bank.remittance.read");
    return {
      cycles: await query<any>(
        `select id,reference_month::text,total_net from public.payroll_cycles where tenant_id=$1 and status='fechada' order by reference_month desc`,
        [data.tenant_id],
      ),
      batches: await query<any>(
        `select * from public.bank_remittance_batches where tenant_id=$1 order by created_at desc`,
        [data.tenant_id],
      ),
    };
  });
