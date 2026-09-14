// O2-09 — Restos a pagar (Onda 2, Lei 4.320, art. 36). No encerramento do
// exercício, os empenhos não pagos são inscritos: PROCESSADOS (liquidados, só
// falta pagar) e NÃO PROCESSADOS (empenhados, ainda não liquidados). Empenho pago
// ou anulado não inscreve; cada empenho inscreve uma só vez. Pagar o resto quita o
// empenho de origem. Reusa budget.*.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio_origem: z.number().int().min(2000).max(2200).optional(),
});

export const getRestosAPagar = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(GetInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    const restos = await query<{
      id: string;
      commitment_id: string;
      exercicio_origem: number;
      tipo: string;
      valor: string;
      inscrito_em: string;
      status: string;
      pago_em: string | null;
      numero: string;
      credor: string;
    }>(
      `select r.id, r.commitment_id, r.exercicio_origem, r.tipo, r.valor::text,
         r.inscrito_em::text, r.status, r.pago_em::text,
         c.numero::text, c.credor
       from public.restos_a_pagar r
       join public.budget_commitments c on c.id = r.commitment_id
       where r.tenant_id = $1
         and ($2::int is null or r.exercicio_origem = $2)
       order by r.exercicio_origem desc, c.numero`,
      [data.tenant_id, data.exercicio_origem ?? null],
    );
    return {
      restos,
      canManage: access.permissions.includes("budget.manage"),
    };
  });

const InscribeInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio: z.number().int().min(2000).max(2200),
  inscrito_em: z.string().date(),
});

// Inscreve em restos a pagar todos os empenhos não pagos do exercício ainda não
// inscritos. Idempotente: reexecutar não duplica.
export const inscribeRestosAPagar = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(InscribeInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const candidatos = (
        await client.query<{
          id: string;
          status: string;
          valor: string;
        }>(
          `select c.id, c.status, c.valor::text
           from public.budget_commitments c
           where c.tenant_id = $1 and c.exercicio = $2
             and c.status in ('empenhado', 'liquidado')
             and not exists (
               select 1 from public.restos_a_pagar r
               where r.commitment_id = c.id and r.tenant_id = c.tenant_id
             )
           for update`,
          [data.tenant_id, data.exercicio],
        )
      ).rows;
      let processados = 0;
      let naoProcessados = 0;
      let valorTotal = 0;
      for (const c of candidatos) {
        const tipo = c.status === "liquidado" ? "processado" : "nao_processado";
        if (tipo === "processado") processados += 1;
        else naoProcessados += 1;
        valorTotal = Number((valorTotal + Number(c.valor)).toFixed(2));
        await client.query(
          `insert into public.restos_a_pagar
             (id, tenant_id, commitment_id, exercicio_origem, tipo, valor,
              inscrito_em, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            data.tenant_id,
            c.id,
            data.exercicio,
            tipo,
            Number(c.valor),
            data.inscrito_em,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "inscrever_restos",
        resource: "restos_a_pagar",
        recordId: data.tenant_id,
        after: {
          exercicio: data.exercicio,
          processados,
          nao_processados: naoProcessados,
          valor_total: valorTotal,
        },
      });
      return {
        inscritos: candidatos.length,
        processados,
        nao_processados: naoProcessados,
        valor_total: valorTotal,
      };
    });
  });

const PayInput = z.object({
  tenant_id: z.string().uuid(),
  resto_id: z.string().uuid(),
  data_pagamento: z.string().date(),
});

// Paga um resto a pagar inscrito: quita o empenho de origem (status 'pago').
export const payRestoAPagar = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(PayInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const resto = (
        await client.query<{ commitment_id: string; status: string }>(
          `select commitment_id, status from public.restos_a_pagar
           where id=$1 and tenant_id=$2 for update`,
          [data.resto_id, data.tenant_id],
        )
      ).rows[0];
      if (!resto) throw new Error("Resto a pagar não encontrado");
      if (resto.status !== "inscrito")
        throw new Error("Só um resto inscrito pode ser pago");
      // O pagamento exige liquidação prévia (Lei 4.320 art. 62/63): trava o
      // empenho de origem e recusa o que ainda não foi liquidado — o resto NÃO
      // processado precisa ser liquidado antes de pagar. Sem esta guarda, o
      // resto pagava empenho em qualquer estado (inclusive já pago ou anulado).
      const commitment = (
        await client.query<{ status: string }>(
          `select status from public.budget_commitments
           where id=$1 and tenant_id=$2 for update`,
          [resto.commitment_id, data.tenant_id],
        )
      ).rows[0];
      if (!commitment) throw new Error("Empenho do resto não encontrado");
      if (commitment.status !== "liquidado")
        throw new Error(
          `Só um empenho liquidado pode ser pago (o empenho está ${commitment.status})`,
        );
      await client.query(
        `update public.restos_a_pagar
         set status='pago', pago_em=$3::date, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.resto_id, data.tenant_id, data.data_pagamento],
      );
      // pago_em recebe a DATA DO PAGAMENTO (não now()): o balanço financeiro
      // separa os exercícios por essa data.
      await client.query(
        `update public.budget_commitments
         set status='pago', pago_em=$3::date, pago_por=$4
         where id=$1 and tenant_id=$2`,
        [
          resto.commitment_id,
          data.tenant_id,
          data.data_pagamento,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "pagar_resto",
        resource: "restos_a_pagar",
        recordId: data.resto_id,
        after: { data_pagamento: data.data_pagamento },
      });
      return { id: data.resto_id, status: "pago" };
    });
  });

const CancelInput = z.object({
  tenant_id: z.string().uuid(),
  resto_id: z.string().uuid(),
  motivo: z.string().trim().min(3).max(500),
  data_cancelamento: z.string().date(),
});

// O2-20 — Cancela um resto a pagar inscrito (Lei 4.320 art. 38 — prescrição/
// insubsistência). A obrigação é extinta: o resto vai a 'cancelado' e o empenho de
// origem, a 'anulado'. Não devolve saldo à dotação (o exercício de origem está encerrado).
export const cancelRestoAPagar = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(CancelInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.manage");
    return withTransaction(async (client) => {
      const resto = (
        await client.query<{ commitment_id: string; status: string }>(
          `select commitment_id, status from public.restos_a_pagar
           where id=$1 and tenant_id=$2 for update`,
          [data.resto_id, data.tenant_id],
        )
      ).rows[0];
      if (!resto) throw new Error("Resto a pagar não encontrado");
      if (resto.status !== "inscrito")
        throw new Error("Só um resto inscrito pode ser cancelado");
      // Trava o empenho e recusa cancelar o que já foi pago ou anulado: sem
      // isto, o cancelamento do resto anulava um empenho PAGO, apagando a
      // despesa dos relatórios com o dinheiro já fora do caixa.
      const commitment = (
        await client.query<{ status: string }>(
          `select status from public.budget_commitments
           where id=$1 and tenant_id=$2 for update`,
          [resto.commitment_id, data.tenant_id],
        )
      ).rows[0];
      if (!commitment) throw new Error("Empenho do resto não encontrado");
      if (commitment.status === "pago")
        throw new Error("Empenho já pago não pode ser anulado");
      if (commitment.status === "anulado")
        throw new Error("Empenho já está anulado");
      await client.query(
        `update public.restos_a_pagar
         set status='cancelado', updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.resto_id, data.tenant_id],
      );
      // Extingue a obrigação: o empenho de origem é anulado.
      await client.query(
        `update public.budget_commitments
         set status='anulado', anulado_em=now(), anulado_por=$3,
             anulado_motivo=$4
         where id=$1 and tenant_id=$2`,
        [resto.commitment_id, data.tenant_id, context.userId, data.motivo],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "cancelar_resto",
        resource: "restos_a_pagar",
        recordId: data.resto_id,
        after: {
          motivo: data.motivo,
          data_cancelamento: data.data_cancelamento,
        },
      });
      return { id: data.resto_id, status: "cancelado" };
    });
  });

const SummaryInput = z.object({
  tenant_id: z.string().uuid(),
  exercicio_origem: z.number().int().min(2000).max(2200).optional(),
});

// O2-09b — Demonstrativo de restos a pagar (Lei 4.320). Consolida os restos inscritos por
// situação (inscrito=a pagar, pago, cancelado) e o saldo **a pagar** (status='inscrito')
// aberto por tipo — processado (liquidado, pronto para pagar) e não processado (ainda a
// liquidar). Read-only, reusa budget.read.
export const getRestosAPagarSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SummaryInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "budget.read");
    const row = (
      await query<{
        q_inscrito: string;
        v_inscrito: string;
        q_pago: string;
        v_pago: string;
        q_cancelado: string;
        v_cancelado: string;
        v_proc: string;
        v_nproc: string;
      }>(
        `select
           count(*) filter (where status='inscrito')::text as q_inscrito,
           coalesce(sum(valor) filter (where status='inscrito'),0)::text as v_inscrito,
           count(*) filter (where status='pago')::text as q_pago,
           coalesce(sum(valor) filter (where status='pago'),0)::text as v_pago,
           count(*) filter (where status='cancelado')::text as q_cancelado,
           coalesce(sum(valor) filter (where status='cancelado'),0)::text as v_cancelado,
           coalesce(sum(valor) filter (where status='inscrito' and tipo='processado'),0)::text as v_proc,
           coalesce(sum(valor) filter (where status='inscrito' and tipo='nao_processado'),0)::text as v_nproc
         from public.restos_a_pagar
         where tenant_id = $1 and ($2::int is null or exercicio_origem = $2)`,
        [data.tenant_id, data.exercicio_origem ?? null],
      )
    )[0];
    return {
      porStatus: {
        inscrito: {
          qtd: Number(row.q_inscrito),
          valor: Number(row.v_inscrito),
        },
        pago: { qtd: Number(row.q_pago), valor: Number(row.v_pago) },
        cancelado: {
          qtd: Number(row.q_cancelado),
          valor: Number(row.v_cancelado),
        },
      },
      saldoAPagar: Number(row.v_inscrito),
      saldoPorTipo: {
        processado: Number(row.v_proc),
        nao_processado: Number(row.v_nproc),
      },
    };
  });
