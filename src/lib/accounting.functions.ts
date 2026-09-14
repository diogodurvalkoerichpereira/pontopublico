// O2-05 — Razão contábil em partidas dobradas (núcleo PCASP). Todo lançamento tem
// linhas de débito e crédito que SE IGUALAM — a `postEntry` (accounting.server.ts)
// recusa desbalanceado. Este arquivo expõe só server functions + configuração do
// roteiro; os helpers de escrituração vivem em accounting.server.ts e os códigos de
// evento em accounting-events.ts (puro), para o cliente poder importar daqui.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import { postEntry } from "./accounting.server";
import { ACCOUNTING_EVENT_CODES } from "./accounting-events";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

export { ACCOUNTING_EVENT_CODES } from "./accounting-events";
export type { AccountingEventCode } from "./accounting-events";

const SaveEventInput = z.object({
  tenant_id: z.string().uuid(),
  event_code: z.enum(ACCOUNTING_EVENT_CODES),
  debit_account: z
    .string()
    .trim()
    .regex(/^[0-9.]{1,30}$/),
  credit_account: z
    .string()
    .trim()
    .regex(/^[0-9.]{1,30}$/),
});

export const saveAccountingEventAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveEventInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.manage");
    await withTransaction(async (client) => {
      await client.query(
        `insert into public.accounting_event_accounts
           (tenant_id, event_code, debit_account, credit_account, created_by)
         values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, event_code) do update
           set debit_account = excluded.debit_account,
               credit_account = excluded.credit_account`,
        [
          data.tenant_id,
          data.event_code,
          data.debit_account,
          data.credit_account,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "update",
        resource: "accounting_event_accounts",
        recordId: data.event_code,
        after: data,
      });
    });
    return { ok: true };
  });

const TenantInput = z.object({ tenant_id: z.string().uuid() });

// O2-06b — Roteiros contábeis configurados do ente: para cada evento
// contabilizável, a conta de débito e a de crédito (ou nada, quando o ente ainda
// não decidiu o roteiro — o fato então não escritura, regra do O2-06). Devolve a
// lista completa de eventos para a tela mostrar os não mapeados. Reusa accounting.read.
export const getAccountingEventAccounts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TenantInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");
    const rows = await query<{
      event_code: string;
      debit_account: string;
      credit_account: string;
    }>(
      `select event_code, debit_account, credit_account
       from public.accounting_event_accounts
       where tenant_id = $1`,
      [data.tenant_id],
    );
    const roteiros = ACCOUNTING_EVENT_CODES.map((event_code) => {
      const r = rows.find((x) => x.event_code === event_code);
      return {
        event_code,
        debit_account: r?.debit_account ?? null,
        credit_account: r?.credit_account ?? null,
        configurado: Boolean(r),
      };
    });
    return {
      roteiros,
      canManage: access.permissions.includes("accounting.manage"),
    };
  });

const PostInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
  data_lancamento: z.string().date(),
  historico: z.string().trim().min(3).max(500),
  lines: z
    .array(
      z.object({
        conta: z
          .string()
          .trim()
          .regex(/^[0-9.]{1,30}$/, "Conta contábil inválida"),
        lado: z.enum(["D", "C"]),
        valor: z.number().positive().max(1_000_000_000_000),
      }),
    )
    .min(2)
    .max(200),
});

export const postAccountingEntry = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(PostInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.manage");
    return withTransaction((client) =>
      postEntry({
        client,
        tenantId: data.tenant_id,
        exercicio: data.exercicio,
        dataLancamento: data.data_lancamento,
        historico: data.historico,
        lines: data.lines,
        source: "manual",
        actorId: context.userId,
      }),
    );
  });
