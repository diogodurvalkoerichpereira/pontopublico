/**
 * Remessa bancária da folha.
 *
 * ATENÇÃO — este módulo NÃO gera CNAB 240. O formato produzido aqui é próprio
 * do projeto: linhas de comprimento variável com um "header", detalhes e um
 * "trailer" simplificados. O CNAB 240 da FEBRABAN exige registros de 240
 * posições fixas, com header de arquivo, header de lote, segmentos A/B/C,
 * trailer de lote e trailer de arquivo. Nenhum banco aceita o arquivo atual.
 *
 * O rótulo gravado em `layout_version` é RASCUNHO-NAO-CNAB240-v1 justamente
 * para que nem a interface nem uma declaração de conformidade em licitação
 * possam apresentá-lo como padrão oficial. Ver src/lib/conformance.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import { conformanceOf } from "./conformance";
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
          // reference_month é `date`: o driver devolve Date, e o layout precisa
          // do texto. Sem o ::text o `.replace` abaixo estourava em toda chamada.
          `select *, reference_month::text as reference_month_text
             from public.payroll_cycles
            where id=$1 and tenant_id=$2 and status='fechada' for update`,
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
        `0${data.bank_code}${pad(cycle.reference_month_text.replace(/-/g, ""), 8)}`,
        ...detail,
        `9${pad(rows.length, 6)}${pad(Math.round(total * 100), 18)}`,
      ].join("\r\n");
      const hash = createHash("sha256").update(content).digest("hex"),
        id = randomUUID();
      await c.query(
        `insert into public.bank_remittance_batches(id,tenant_id,payroll_cycle_id,bank_code,layout_version,records_count,total_amount,file_content,file_sha256,created_by)values($1,$2,$3,$4,'RASCUNHO-NAO-CNAB240-v1',$5,$6,$7,$8,$9)`,
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
      // Trilha de auditoria do ato de saída de dados (remessa bancária).
      await recordAudit(c, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "remessa.gerar",
        resource: "bank_remittance_batches",
        recordId: id,
        after: {
          bank_code: data.bank_code,
          payroll_cycle_id: cycle.id,
          records_count: rows.length,
          total_amount: total,
          file_sha256: hash,
        },
      });
      return {
        id,
        content,
        hash,
        total,
        conformidade: conformanceOf("remessa-bancaria"),
      };
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
