/**
 * Movimento de tesouraria — o único caminho que toca o caixa.
 *
 * SOMENTE servidor. Era uma função privada de `treasury.functions.ts`, e por
 * estar privada a arrecadação não tinha como usá-la: receita e tributo
 * arrecadados incrementavam o `valor_arrecadado` e **não entravam em conta
 * nenhuma**. O caixa ficava parado em zero enquanto os relatórios mostravam
 * receita, e toda ordem bancária era recusada por saldo insuficiente.
 *
 * Fica aqui, e não em `*.functions.ts`, pela regra do CLAUDE.md: helper de
 * servidor (usa `node:crypto`) exportado de um `.functions.ts` sobrevive no
 * bundle do cliente assim que uma rota importa o arquivo.
 */
import { randomUUID } from "node:crypto";

export type TreasuryMovementKind =
  "ingresso" | "saida" | "transferencia_entrada" | "transferencia_saida";

type MinimalClient = {
  query: <T>(t: string, p?: unknown[]) => Promise<{ rows: T[] }>;
};

/**
 * Aplica um ingresso/saída na conta (travada FOR UPDATE); a saída nunca deixa o
 * saldo negativo. Devolve o novo saldo.
 */
export async function applyMovement(
  client: MinimalClient,
  params: {
    tenantId: string;
    accountId: string;
    tipo: TreasuryMovementKind;
    dataMovimento: string;
    valor: number;
    historico: string;
    transferRef: string | null;
    actorId: string;
  },
): Promise<number> {
  const account = (
    await client.query<{ saldo_atual: string; status: string }>(
      `select saldo_atual::text, status from public.treasury_accounts
       where id=$1 and tenant_id=$2 for update`,
      [params.accountId, params.tenantId],
    )
  ).rows[0];
  if (!account) throw new Error("Conta não encontrada");
  if (account.status !== "ativa")
    throw new Error("Conta encerrada não movimenta");
  const saida =
    params.tipo === "saida" || params.tipo === "transferencia_saida";
  const saldoAtual = Number(account.saldo_atual);
  if (saida && params.valor > saldoAtual)
    throw new Error(
      `Saída (${params.valor.toFixed(2)}) deixaria o saldo negativo (atual ${saldoAtual.toFixed(2)})`,
    );
  const novoSaldo = Number(
    (saida ? saldoAtual - params.valor : saldoAtual + params.valor).toFixed(2),
  );
  await client.query(
    `insert into public.treasury_movements
       (id, tenant_id, account_id, tipo, data_movimento, valor, historico,
        saldo_apos, transfer_ref, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      params.tenantId,
      params.accountId,
      params.tipo,
      params.dataMovimento,
      params.valor,
      params.historico,
      novoSaldo,
      params.transferRef,
      params.actorId,
    ],
  );
  await client.query(
    `update public.treasury_accounts set saldo_atual=$3, updated_at=now()
     where id=$1 and tenant_id=$2`,
    [params.accountId, params.tenantId, novoSaldo],
  );
  return novoSaldo;
}
