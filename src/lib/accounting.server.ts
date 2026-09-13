// O2-05/O2-06 — Escrituração no razão (servidor). `postEntry(client, …)` grava um
// lançamento balanceado na transação do chamador; `contabilizarEvento` lê o roteiro
// do ente (accounting_event_accounts) e escritura o fato, se houver roteiro. Vive em
// *.server.ts porque usa node:crypto e a trilha de auditoria — e por isso NUNCA é
// importado do cliente (O2-06b: importar helpers puros de um *.functions.ts numa
// rota levava `randomUUID` ao bundle do navegador e quebrava o build).
import { randomUUID } from "node:crypto";
import { recordAudit } from "./audit.server";
import type { AccountingEventCode } from "./accounting-events";

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
  eventCode: AccountingEventCode;
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
