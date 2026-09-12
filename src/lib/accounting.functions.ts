// O2-05 — Razão contábil em partidas dobradas (núcleo PCASP). Todo lançamento tem
// linhas de débito e crédito que SE IGUALAM — a `postEntry` recusa desbalanceado.
// O helper `postEntry(client, ...)` é reusado pelos roteiros de contabilização
// automática (empenho/liquidação/pagamento) dentro da mesma transação do fato.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const round2 = (value: number) => Number(value.toFixed(2));

export type EntryLine = { conta: string; lado: "D" | "C"; valor: number };

export type PostEntryInput = {
  client: import("pg").PoolClient;
  tenantId: string;
  exercicio: number;
  dataLancamento: string;
  historico: string;
  lines: EntryLine[];
  source: string;
  sourceRef?: string | null;
  actorId: string;
};

// Escritura um lançamento balanceado (Σdébito = Σcrédito). Transação do chamador.
export async function postEntry(input: PostEntryInput) {
  if (input.lines.length < 2)
    throw new Error("Lançamento exige ao menos um débito e um crédito");
  const totalD = round2(
    input.lines.filter((l) => l.lado === "D").reduce((s, l) => s + l.valor, 0),
  );
  const totalC = round2(
    input.lines.filter((l) => l.lado === "C").reduce((s, l) => s + l.valor, 0),
  );
  if (totalD !== totalC)
    throw new Error(
      `Lançamento desbalanceado: débito ${totalD.toFixed(2)} ≠ crédito ${totalC.toFixed(2)}`,
    );
  if (totalD <= 0) throw new Error("Lançamento sem valor");

  const { client } = input;
  const id = randomUUID();
  await client.query(
    `insert into public.accounting_entries
       (id, tenant_id, exercicio, data_lancamento, historico, source, source_ref,
        valor, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.tenantId,
      input.exercicio,
      input.dataLancamento,
      input.historico,
      input.source,
      input.sourceRef ?? null,
      totalD,
      input.actorId,
    ],
  );
  for (const line of input.lines) {
    await client.query(
      `insert into public.accounting_entry_lines
         (tenant_id, entry_id, conta, lado, valor)
       values ($1,$2,$3,$4,$5)`,
      [input.tenantId, id, line.conta, line.lado, round2(line.valor)],
    );
  }
  await recordAudit(client, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    action: "post_entry",
    resource: "accounting_entries",
    recordId: id,
    after: { historico: input.historico, valor: totalD, source: input.source },
  });
  return { id, valor: totalD };
}

// O2-06 — contabilização automática dirigida por configuração. Lê o mapeamento
// conta débito/crédito do evento (`accounting_event_accounts`) e, se existir,
// escritura o lançamento balanceado do fato na MESMA transação. Sem mapeamento, o
// fato não contabiliza (devolve null) — o ente decide o roteiro. Reusado pelas
// funções de empenho/liquidação/pagamento (budget.functions).
export async function contabilizarEvento(params: {
  client: import("pg").PoolClient;
  tenantId: string;
  exercicio: number;
  dataLancamento: string;
  eventCode: "empenho" | "empenho_anulacao" | "liquidacao" | "pagamento";
  valor: number;
  historico: string;
  sourceRef?: string | null;
  actorId: string;
}) {
  if (params.valor <= 0) return null;
  const mapping = (
    await params.client.query<{
      debit_account: string;
      credit_account: string;
    }>(
      `select debit_account, credit_account
       from public.accounting_event_accounts
       where tenant_id = $1 and event_code = $2`,
      [params.tenantId, params.eventCode],
    )
  ).rows[0];
  if (!mapping) return null;
  return postEntry({
    client: params.client,
    tenantId: params.tenantId,
    exercicio: params.exercicio,
    dataLancamento: params.dataLancamento,
    historico: params.historico,
    lines: [
      { conta: mapping.debit_account, lado: "D", valor: params.valor },
      { conta: mapping.credit_account, lado: "C", valor: params.valor },
    ],
    source: `evento:${params.eventCode}`,
    sourceRef: params.sourceRef ?? null,
    actorId: params.actorId,
  });
}

const SaveEventInput = z.object({
  tenant_id: z.string().uuid(),
  event_code: z.enum([
    "empenho",
    "empenho_anulacao",
    "liquidacao",
    "pagamento",
  ]),
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
  .validator((data: unknown) => SaveEventInput.parse(data))
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
  .validator((data: unknown) => PostInput.parse(data))
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

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200).optional(),
});

export const getAccountingEntries = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");
    const entries = await query<{
      id: string;
      exercicio: number;
      data_lancamento: string;
      historico: string;
      source: string;
      valor: string;
    }>(
      `select id, exercicio, data_lancamento::text, historico, source, valor::text
       from public.accounting_entries
       where tenant_id = $1 and ($2::int is null or exercicio = $2)
       order by data_lancamento desc, created_at desc
       limit 500`,
      [data.tenant_id, data.exercicio ?? null],
    );
    return { entries };
  });

const BalanceteInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
});

// Balancete: saldo por conta (Σdébito - Σcrédito) no exercício.
export const getBalancete = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => BalanceteInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "accounting.read");
    return query<{
      conta: string;
      debito: string;
      credito: string;
      saldo: string;
    }>(
      `select l.conta,
         coalesce(sum(case when l.lado='D' then l.valor else 0 end),0)::text as debito,
         coalesce(sum(case when l.lado='C' then l.valor else 0 end),0)::text as credito,
         coalesce(sum(case when l.lado='D' then l.valor else -l.valor end),0)::text as saldo
       from public.accounting_entry_lines l
       join public.accounting_entries e on e.id = l.entry_id
       where l.tenant_id = $1 and e.exercicio = $2
       group by l.conta
       order by l.conta`,
      [data.tenant_id, data.exercicio],
    );
  });
