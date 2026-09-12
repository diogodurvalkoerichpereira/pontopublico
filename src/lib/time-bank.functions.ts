// O1-03f — Banco de horas persistente: razao do saldo acumulado do ponto apurado,
// por vinculo e competencia. O saldo do mes (minutes, com sinal) e um lancamento
// gerencial do RH — pre-preenchido pelo resumo de apuracao (O1-03g), mas decidido
// pelo RH (ex.: apos corrigir marcacoes inconsistentes). O saldo ACUMULADO
// (balance_after) e sempre recalculado pelo servidor, em ordem de competencia,
// para que lancar/retificar um mes no meio reordene os seguintes.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const PostInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  reference_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  minutes: z.number().int().min(-1_000_000).max(1_000_000),
  note: z.string().trim().max(300).nullable().optional(),
});

/** Lanca (ou retifica) o saldo do mes no banco de horas de um vinculo e recalcula
 *  o saldo acumulado de todas as competencias do vinculo, em ordem. Guard
 *  people.manage. */
export const postTimeBankEntry = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => PostInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.manage");
    const referenceDate = `${data.reference_month}-01`;
    return withTransaction(async (client) => {
      // O vinculo tem de ser do ente (defesa em profundidade; o trigger tambem valida).
      const link = (
        await client.query<{ id: string }>(
          "select id from public.employment_links where id=$1 and tenant_id=$2",
          [data.employment_link_id, data.tenant_id],
        )
      ).rows[0];
      if (!link) throw new Error("Vínculo inválido para esta entidade");
      // Trava as entradas do vinculo para serializar o recalculo do acumulado.
      await client.query(
        `select id from public.time_bank_entries
         where tenant_id=$1 and employment_link_id=$2 for update`,
        [data.tenant_id, data.employment_link_id],
      );
      // Upsert do mes (minutes). O balance_after e provisorio; sera reescrito abaixo.
      await client.query(
        `insert into public.time_bank_entries
           (tenant_id, employment_link_id, reference_month, minutes, balance_after, note, created_by)
         values ($1,$2,$3::date,$4,0,$5,$6)
         on conflict (tenant_id, employment_link_id, reference_month) do update
           set minutes = excluded.minutes,
               note = excluded.note,
               updated_at = now()`,
        [
          data.tenant_id,
          data.employment_link_id,
          referenceDate,
          data.minutes,
          data.note ?? null,
          context.userId,
        ],
      );
      // Recalcula o acumulado em ordem de competencia (fonte unica da verdade).
      const rows = (
        await client.query<{ id: string; minutes: number }>(
          `select id, minutes from public.time_bank_entries
           where tenant_id=$1 and employment_link_id=$2
           order by reference_month`,
          [data.tenant_id, data.employment_link_id],
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
      // Saldo apos a competencia lancada = acumulado ate ela (inclusive).
      const alvo = (
        await client.query<{ balance_after: number }>(
          `select balance_after from public.time_bank_entries
           where tenant_id=$1 and employment_link_id=$2 and reference_month=$3::date`,
          [data.tenant_id, data.employment_link_id, referenceDate],
        )
      ).rows[0];
      const balanceAfter = Number(alvo?.balance_after ?? 0);
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "post_time_bank",
        resource: "time_bank_entries",
        recordId: data.employment_link_id,
        after: {
          reference_month: referenceDate,
          minutes: data.minutes,
          balance_after: balanceAfter,
        },
      });
      return {
        reference_month: data.reference_month,
        minutes: data.minutes,
        balance_after: balanceAfter,
      };
    });
  });

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid().optional(),
});

/** Razao do banco de horas: entradas (mes, saldo do mes, saldo acumulado) por
 *  vinculo. Sem `employment_link_id`, traz o de todos os vinculos do ente. Guard
 *  people.read. */
export const getTimeBank = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.read");
    const entries = await query<{
      employment_link_id: string;
      registration_number: string | null;
      full_name: string;
      reference_month: string;
      minutes: number;
      balance_after: number;
      note: string | null;
    }>(
      `select t.employment_link_id, l.registration_number, p.full_name,
              to_char(t.reference_month, 'YYYY-MM') as reference_month,
              t.minutes, t.balance_after, t.note
       from public.time_bank_entries t
       join public.employment_links l on l.id = t.employment_link_id
       join public.persons p on p.id = l.person_id
       where t.tenant_id = $1
         and ($2::uuid is null or t.employment_link_id = $2)
       order by p.full_name, t.employment_link_id, t.reference_month`,
      [data.tenant_id, data.employment_link_id ?? null],
    );
    const links = await query<{
      id: string;
      registration_number: string | null;
      full_name: string;
    }>(
      `select l.id, l.registration_number, p.full_name
       from public.employment_links l
       join public.persons p on p.id = l.person_id
       where l.tenant_id = $1 and l.status = 'ativo'
       order by p.full_name`,
      [data.tenant_id],
    );
    return {
      entries: entries.map((e) => ({
        ...e,
        minutes: Number(e.minutes),
        balance_after: Number(e.balance_after),
      })),
      links,
      canManage: access.permissions.includes("people.manage"),
    };
  });
