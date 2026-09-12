// O1-03f — Núcleo do razão do banco de horas, compartilhado pelo lançamento
// manual (time-bank.functions) e pelo lançamento a partir da apuração
// (time-clock.functions). Não faz auditoria nem checa permissão: isso é
// responsabilidade de cada handler. Recebe o `client` da transação em curso.
import type { PoolClient } from "pg";

interface UpsertParams {
  tenantId: string;
  employmentLinkId: string;
  referenceMonth: string; // "YYYY-MM"
  minutes: number;
  note: string | null;
  createdBy: string;
}

/**
 * Faz o upsert do saldo do mês e recalcula o saldo acumulado (balance_after) de
 * TODAS as competências do vínculo, em ordem de competência. Deve rodar dentro de
 * uma transação; trava as entradas do vínculo (`for update`) para serializar o
 * recálculo. Devolve o acumulado após a competência lançada.
 */
export async function upsertAndRebalanceTimeBank(
  client: PoolClient,
  {
    tenantId,
    employmentLinkId,
    referenceMonth,
    minutes,
    note,
    createdBy,
  }: UpsertParams,
): Promise<number> {
  const referenceDate = `${referenceMonth}-01`;
  await client.query(
    `select id from public.time_bank_entries
     where tenant_id=$1 and employment_link_id=$2 for update`,
    [tenantId, employmentLinkId],
  );
  await client.query(
    `insert into public.time_bank_entries
       (tenant_id, employment_link_id, reference_month, minutes, balance_after, note, created_by)
     values ($1,$2,$3::date,$4,0,$5,$6)
     on conflict (tenant_id, employment_link_id, reference_month) do update
       set minutes = excluded.minutes,
           note = excluded.note,
           updated_at = now()`,
    [tenantId, employmentLinkId, referenceDate, minutes, note, createdBy],
  );
  const rows = (
    await client.query<{ id: string; minutes: number }>(
      `select id, minutes from public.time_bank_entries
       where tenant_id=$1 and employment_link_id=$2
       order by reference_month`,
      [tenantId, employmentLinkId],
    )
  ).rows;
  let running = 0;
  for (const row of rows) {
    running += Number(row.minutes);
    await client.query(
      "update public.time_bank_entries set balance_after=$1 where id=$2",
      [running, row.id],
    );
  }
  const alvo = (
    await client.query<{ balance_after: number }>(
      `select balance_after from public.time_bank_entries
       where tenant_id=$1 and employment_link_id=$2 and reference_month=$3::date`,
      [tenantId, employmentLinkId, referenceDate],
    )
  ).rows[0];
  return Number(alvo?.balance_after ?? 0);
}
