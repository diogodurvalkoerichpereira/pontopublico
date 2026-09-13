// O3-06 — Licitação / processo licitatório (Lei 14.133). O certame que antecede o
// contrato: abertura → homologada / fracassada / deserta / revogada. Reusa
// contracts.*.
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

const GetInput = z.object({
  tenant_id: z.string().uuid(),
  ano: z.number().int().min(2000).max(2200).optional(),
});

export const getProcurementProcesses = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const processes = await query<{
      id: string;
      numero: string;
      ano: number;
      modalidade: string;
      objeto: string;
      valor_estimado: string;
      status: string;
      abertura: string;
      homologado_em: string | null;
      valor_homologado: string | null;
      vencedor: string | null;
    }>(
      `select p.id, p.numero, p.ano, p.modalidade, p.objeto,
         p.valor_estimado::text, p.status, p.abertura::text, p.homologado_em::text,
         p.valor_homologado::text, v.fornecedor as vencedor
       from public.procurement_processes p
       left join public.procurement_proposals v on v.id = p.vencedor_proposal_id
       where p.tenant_id = $1 and ($2::int is null or p.ano = $2)
       order by p.ano desc, p.numero`,
      [data.tenant_id, data.ano ?? null],
    );
    return {
      processes,
      canManage: access.permissions.includes("contracts.manage"),
    };
  });

const SummaryInput = z.object({
  tenant_id: z.string().uuid(),
  ano: z.number().int().min(2000).max(2200).optional(),
});

// O3-06b — Resumo das licitações. Consolida a contagem por desfecho
// (aberta/homologada/fracassada/deserta/revogada), o valor estimado total e o **valor
// homologado** das já homologadas. Reusa contracts.read.
export const getProcurementSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SummaryInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const row = (
      await query<{
        aberta: string;
        homologada: string;
        fracassada: string;
        deserta: string;
        revogada: string;
        valor_estimado: string;
        valor_homologado: string;
        total: string;
      }>(
        `select
           count(*) filter (where status='aberta')::text as aberta,
           count(*) filter (where status='homologada')::text as homologada,
           count(*) filter (where status='fracassada')::text as fracassada,
           count(*) filter (where status='deserta')::text as deserta,
           count(*) filter (where status='revogada')::text as revogada,
           coalesce(sum(valor_estimado),0)::text as valor_estimado,
           coalesce(sum(valor_homologado) filter (where status='homologada'),0)::text as valor_homologado,
           count(*)::text as total
         from public.procurement_processes
         where tenant_id = $1 and ($2::int is null or ano = $2)`,
        [data.tenant_id, data.ano ?? null],
      )
    )[0];
    return {
      porStatus: {
        aberta: Number(row.aberta),
        homologada: Number(row.homologada),
        fracassada: Number(row.fracassada),
        deserta: Number(row.deserta),
        revogada: Number(row.revogada),
      },
      valorEstimado: Number(row.valor_estimado),
      valorHomologado: Number(row.valor_homologado),
      total: Number(row.total),
    };
  });

const OpenInput = z.object({
  tenant_id: z.string().uuid(),
  numero: z.string().trim().min(1).max(40),
  ano: z.number().int().min(2000).max(2200),
  modalidade: z.enum([
    "pregao",
    "concorrencia",
    "concurso",
    "leilao",
    "dialogo_competitivo",
    "dispensa",
    "inexigibilidade",
    "credenciamento",
  ]),
  objeto: z.string().trim().min(3).max(500),
  valor_estimado: z.number().positive().max(1_000_000_000_000),
  abertura: z.string().date(),
});

export const openProcurementProcess = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => OpenInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    const id = randomUUID();
    await withTransaction(async (client) => {
      const dup = await client.query(
        `select id from public.procurement_processes
         where tenant_id=$1 and ano=$2 and lower(numero)=lower($3)`,
        [data.tenant_id, data.ano, data.numero],
      );
      if (dup.rows.length)
        throw new Error("Já existe licitação com este número no ano");
      await client.query(
        `insert into public.procurement_processes
           (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado,
            abertura, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          data.numero,
          data.ano,
          data.modalidade,
          data.objeto,
          data.valor_estimado,
          data.abertura,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "open",
        resource: "procurement_processes",
        recordId: id,
        after: { numero: data.numero, ano: data.ano },
      });
    });
    return { id };
  });

const TransitionInput = z.object({
  tenant_id: z.string().uuid(),
  process_id: z.string().uuid(),
  desfecho: z.enum(["homologada", "fracassada", "deserta", "revogada"]),
  data_referencia: z.string().date(),
});

// Encerra o certame com um desfecho. Só uma licitação aberta transita.
export const transitionProcurementProcess = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TransitionInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const process = (
        await client.query<{ status: string }>(
          `select status from public.procurement_processes
           where id=$1 and tenant_id=$2 for update`,
          [data.process_id, data.tenant_id],
        )
      ).rows[0];
      if (!process) throw new Error("Licitação não encontrada");
      if (process.status !== "aberta")
        throw new Error("Só uma licitação aberta pode ser encerrada");
      await client.query(
        `update public.procurement_processes
         set status=$3,
             homologado_em=case when $3='homologada' then $4::date else homologado_em end,
             updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.process_id, data.tenant_id, data.desfecho, data.data_referencia],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.desfecho,
        resource: "procurement_processes",
        recordId: data.process_id,
        after: { desfecho: data.desfecho },
      });
      return { id: data.process_id, status: data.desfecho };
    });
  });

const ProposalInput = z.object({
  tenant_id: z.string().uuid(),
  process_id: z.string().uuid(),
  fornecedor: z.string().trim().min(2).max(200),
  fornecedor_documento: z.string().trim().min(3).max(20),
  valor_proposto: z.number().positive().max(1_000_000_000_000),
  desclassificada: z.boolean().default(false),
  motivo_desclassificacao: z.string().trim().min(3).max(500).optional(),
});

// O3-08b — Registra a proposta de um fornecedor numa licitação **aberta** (só se recebe
// proposta enquanto o certame não encerrou). Uma proposta por fornecedor/licitação. Pode
// já entrar desclassificada, com motivo. Reusa contracts.manage.
export const recordProcurementProposal = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => ProposalInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    if (data.desclassificada && !data.motivo_desclassificacao)
      throw new Error("Desclassificação exige motivo");
    return withTransaction(async (client) => {
      const process = (
        await client.query<{ status: string }>(
          `select status from public.procurement_processes
           where id=$1 and tenant_id=$2 for update`,
          [data.process_id, data.tenant_id],
        )
      ).rows[0];
      if (!process) throw new Error("Licitação não encontrada");
      if (process.status !== "aberta")
        throw new Error("Só uma licitação aberta recebe propostas");
      const dup = await client.query(
        `select id from public.procurement_proposals
         where process_id=$1 and lower(fornecedor_documento)=lower($2)`,
        [data.process_id, data.fornecedor_documento],
      );
      if (dup.rows.length)
        throw new Error("Fornecedor já tem proposta nesta licitação");
      const id = randomUUID();
      await client.query(
        `insert into public.procurement_proposals
           (id, tenant_id, process_id, fornecedor, fornecedor_documento,
            valor_proposto, desclassificada, motivo_desclassificacao, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          data.process_id,
          data.fornecedor,
          data.fornecedor_documento,
          data.valor_proposto,
          data.desclassificada,
          data.motivo_desclassificacao ?? null,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "proposal",
        resource: "procurement_proposals",
        recordId: id,
        after: {
          fornecedor: data.fornecedor,
          valor_proposto: data.valor_proposto,
          desclassificada: data.desclassificada,
        },
      });
      return { id };
    });
  });

const JudgmentInput = z.object({
  tenant_id: z.string().uuid(),
  process_id: z.string().uuid(),
});

// O3-08b — Julgamento por menor preço (Lei 14.133 art. 33-34). Ordena as propostas do
// menor para o maior valor; as **classificadas** (não desclassificadas) recebem a
// classificação 1, 2, 3…; a de menor valor entre as classificadas é a vencedora. Proposta
// desclassificada aparece na lista mas não recebe classificação nem vence. Reusa
// contracts.read.
export const getProcurementJudgment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => JudgmentInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const rows = await query<{
      id: string;
      fornecedor: string;
      fornecedor_documento: string;
      valor_proposto: string;
      desclassificada: boolean;
      motivo_desclassificacao: string | null;
    }>(
      `select id, fornecedor, fornecedor_documento, valor_proposto::text,
         desclassificada, motivo_desclassificacao
       from public.procurement_proposals
       where process_id = $1 and tenant_id = $2
       order by valor_proposto asc, fornecedor`,
      [data.process_id, data.tenant_id],
    );
    let rank = 0;
    const proposals = rows.map((p) => {
      const classificada = !p.desclassificada;
      const classificacao = classificada ? (rank += 1) : null;
      return {
        id: p.id,
        fornecedor: p.fornecedor,
        fornecedor_documento: p.fornecedor_documento,
        valor_proposto: Number(p.valor_proposto),
        desclassificada: p.desclassificada,
        motivo_desclassificacao: p.motivo_desclassificacao,
        classificacao,
      };
    });
    const vencedor = proposals.find((p) => p.classificacao === 1) ?? null;
    return { proposals, vencedor };
  });

const AwardInput = z.object({
  tenant_id: z.string().uuid(),
  process_id: z.string().uuid(),
});

// O3-08c — Adjudicação do vencedor (Lei 14.133 art. 71). Numa licitação **homologada**,
// fixa a proposta vencedora — a de menor valor entre as **classificadas** (não
// desclassificadas) — e o valor homologado. Exige ao menos uma proposta classificada.
// Reusa contracts.manage.
export const adjudicateProcurementWinner = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => AwardInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const process = (
        await client.query<{ status: string }>(
          `select status from public.procurement_processes
           where id=$1 and tenant_id=$2 for update`,
          [data.process_id, data.tenant_id],
        )
      ).rows[0];
      if (!process) throw new Error("Licitação não encontrada");
      if (process.status !== "homologada")
        throw new Error("Só uma licitação homologada adjudica o vencedor");
      // Menor valor entre as classificadas (não desclassificadas).
      const winner = (
        await client.query<{ id: string; valor_proposto: string }>(
          `select id, valor_proposto::text
           from public.procurement_proposals
           where process_id=$1 and tenant_id=$2 and desclassificada = false
           order by valor_proposto asc, fornecedor
           limit 1`,
          [data.process_id, data.tenant_id],
        )
      ).rows[0];
      if (!winner)
        throw new Error("Não há proposta classificada para adjudicar");
      await client.query(
        `update public.procurement_processes
         set vencedor_proposal_id=$3, valor_homologado=$4, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.process_id, data.tenant_id, winner.id, winner.valor_proposto],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "adjudicate",
        resource: "procurement_processes",
        recordId: data.process_id,
        after: {
          vencedor_proposal_id: winner.id,
          valor_homologado: Number(winner.valor_proposto),
        },
      });
      return {
        id: data.process_id,
        vencedor_proposal_id: winner.id,
        valor_homologado: Number(winner.valor_proposto),
      };
    });
  });

const SavingsInput = z.object({
  tenant_id: z.string().uuid(),
  ano: z.number().int().min(2000).max(2200).optional(),
});

// O3-08d — Economia da licitação (Lei 14.133, princípio da eficiência). Para os certames
// já adjudicados (valor homologado definido), a economia = valor estimado − valor
// homologado e o percentual sobre o estimado; consolida o estimado, o homologado e a
// economia totais, com o percentual agregado. O painel geral só somava o estimado de TODOS
// os processos (não só os adjudicados), então subtrair de lá não dava a economia real —
// aqui a base é a mesma nos dois lados. Read-only, reusa contracts.read.
export const getProcurementSavings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SavingsInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const rows = await query<{
      id: string;
      numero: string;
      ano: number;
      modalidade: string;
      objeto: string;
      valor_estimado: string;
      valor_homologado: string;
      homologado_em: string | null;
    }>(
      `select id, numero, ano, modalidade, objeto,
         valor_estimado::text, valor_homologado::text, homologado_em::text
       from public.procurement_processes
       where tenant_id = $1 and valor_homologado is not null
         and ($2::int is null or ano = $2)
       order by homologado_em desc nulls last, ano desc, numero`,
      [data.tenant_id, data.ano ?? null],
    );
    const round2 = (v: number) => Number(v.toFixed(2));
    const processos = rows.map((r) => {
      const estimado = Number(r.valor_estimado);
      const homologado = Number(r.valor_homologado);
      const economia = round2(estimado - homologado);
      return {
        id: r.id,
        numero: r.numero,
        ano: r.ano,
        modalidade: r.modalidade,
        objeto: r.objeto,
        valor_estimado: round2(estimado),
        valor_homologado: round2(homologado),
        economia,
        // Percentual da economia sobre o estimado (0 quando estimado é 0).
        percentual: estimado > 0 ? round2((economia / estimado) * 100) : 0,
      };
    });
    const totalEstimado = round2(
      processos.reduce((s, p) => s + p.valor_estimado, 0),
    );
    const totalHomologado = round2(
      processos.reduce((s, p) => s + p.valor_homologado, 0),
    );
    const totalEconomia = round2(totalEstimado - totalHomologado);
    return {
      processos,
      totais: {
        estimado: totalEstimado,
        homologado: totalHomologado,
        economia: totalEconomia,
        percentual:
          totalEstimado > 0 ? round2((totalEconomia / totalEstimado) * 100) : 0,
      },
    };
  });

const DisqualifyInput = z.object({
  tenant_id: z.string().uuid(),
  process_id: z.string().uuid(),
  proposal_id: z.string().uuid(),
  motivo: z.string().trim().min(3).max(500),
});

// O3-08e — Desclassificação de proposta durante o julgamento (Lei 14.133 art. 59). Numa
// licitação ainda **aberta**, marca uma proposta classificada como desclassificada, com
// motivo — ela deixa de ser classificada e de concorrer à adjudicação (a menor entre as
// classificadas passa a ser outra). Só numa licitação aberta; proposta já desclassificada
// não desclassifica de novo. Reusa contracts.manage.
export const disqualifyProcurementProposal = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => DisqualifyInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const process = (
        await client.query<{ status: string }>(
          `select status from public.procurement_processes
           where id=$1 and tenant_id=$2 for update`,
          [data.process_id, data.tenant_id],
        )
      ).rows[0];
      if (!process) throw new Error("Licitação não encontrada");
      if (process.status !== "aberta")
        throw new Error(
          "Só numa licitação aberta uma proposta pode ser desclassificada",
        );
      const proposal = (
        await client.query<{ desclassificada: boolean }>(
          `select desclassificada from public.procurement_proposals
           where id=$1 and process_id=$2 and tenant_id=$3 for update`,
          [data.proposal_id, data.process_id, data.tenant_id],
        )
      ).rows[0];
      if (!proposal) throw new Error("Proposta não encontrada");
      if (proposal.desclassificada)
        throw new Error("Proposta já desclassificada");
      await client.query(
        `update public.procurement_proposals
         set desclassificada=true, motivo_desclassificacao=$3
         where id=$1 and tenant_id=$2`,
        [data.proposal_id, data.tenant_id, data.motivo],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "disqualify_proposal",
        resource: "procurement_proposals",
        recordId: data.proposal_id,
        after: { desclassificada: true, motivo: data.motivo },
      });
      return { id: data.proposal_id, desclassificada: true };
    });
  });
