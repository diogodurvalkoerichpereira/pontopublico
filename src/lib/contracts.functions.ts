// O3-01 — Contratos administrativos (Lei 14.133). Espelha o padrão da casa:
// createServerFn + loadTenantAccess + requireTenantPermission, dedup por
// número/ano, auditado. O valor_empenhado é gerido pela ligação com o empenho
// (incremento futuro), não por este write-path.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, queryOne, withTransaction } from "./db.server";
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

export const getContracts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => GetInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const contracts = await query<{
      id: string;
      numero: string;
      ano: number;
      fornecedor: string;
      objeto: string;
      modalidade: string;
      valor_total: string;
      valor_empenhado: string;
      saldo: string;
      vigencia_inicio: string;
      vigencia_fim: string;
      status: string;
    }>(
      `select id, numero, ano, fornecedor, objeto, modalidade,
         valor_total::text, valor_empenhado::text,
         (valor_total - valor_empenhado)::text as saldo,
         vigencia_inicio::text, vigencia_fim::text, status
       from public.procurement_contracts
       where tenant_id = $1 and ($2::int is null or ano = $2)
       order by ano desc, numero`,
      [data.tenant_id, data.ano ?? null],
    );
    return {
      contracts,
      canManage: access.permissions.includes("contracts.manage"),
    };
  });

const SummaryInput = z.object({
  tenant_id: z.string().uuid(),
  ano: z.number().int().min(2000).max(2200).optional(),
});

// O3-01b — Resumo dos contratos administrativos. Consolida a contagem por situação e, dos
// contratos **vigentes**, o valor contratado, o empenhado, o executado (medições) e o
// saldo a executar (contratado − executado). Contrato encerrado/rescindido não entra no
// carteira vigente. Reusa contracts.read.
export const getContractsSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SummaryInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.read");
    const row = (
      await query<{
        vigentes: string;
        suspensos: string;
        encerrados: string;
        rescindidos: string;
        valor_contratado: string;
        valor_empenhado: string;
        valor_executado: string;
        saldo_a_executar: string;
      }>(
        `select
           count(*) filter (where status='vigente')::text as vigentes,
           count(*) filter (where status='suspenso')::text as suspensos,
           count(*) filter (where status='encerrado')::text as encerrados,
           count(*) filter (where status='rescindido')::text as rescindidos,
           coalesce(sum(valor_total) filter (where status='vigente'),0)::text as valor_contratado,
           coalesce(sum(valor_empenhado) filter (where status='vigente'),0)::text as valor_empenhado,
           coalesce(sum(valor_executado) filter (where status='vigente'),0)::text as valor_executado,
           coalesce(sum(valor_total - valor_executado) filter (where status='vigente'),0)::text as saldo_a_executar
         from public.procurement_contracts
         where tenant_id = $1 and ($2::int is null or ano = $2)`,
        [data.tenant_id, data.ano ?? null],
      )
    )[0];
    return {
      porStatus: {
        vigente: Number(row.vigentes),
        suspenso: Number(row.suspensos),
        encerrado: Number(row.encerrados),
        rescindido: Number(row.rescindidos),
      },
      valorContratado: Number(row.valor_contratado),
      valorEmpenhado: Number(row.valor_empenhado),
      valorExecutado: Number(row.valor_executado),
      saldoAExecutar: Number(row.saldo_a_executar),
    };
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  numero: z.string().trim().min(1).max(40),
  ano: z.number().int().min(2000).max(2200),
  fornecedor: z.string().trim().min(2).max(200),
  fornecedor_documento: z.string().trim().min(3).max(20),
  objeto: z.string().trim().min(3).max(500),
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
  valor_total: z.number().positive().max(1_000_000_000_000),
  vigencia_inicio: z.string().date(),
  vigencia_fim: z.string().date(),
  status: z
    .enum(["vigente", "suspenso", "encerrado", "rescindido"])
    .default("vigente"),
});

export const saveContract = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    if (data.vigencia_fim < data.vigencia_inicio)
      throw new Error("A vigência final não pode anteceder a inicial");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.procurement_contracts
       where tenant_id = $1 and ano = $2 and lower(numero) = lower($3)
         and ($4::uuid is null or id <> $4)`,
      [data.tenant_id, data.ano, data.numero, data.id ?? null],
    );
    if (duplicate) throw new Error("Já existe contrato com este número no ano");
    const before = data.id
      ? await queryOne<{ valor_empenhado: string }>(
          "select valor_empenhado::text from public.procurement_contracts where id=$1 and tenant_id=$2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Contrato não encontrado");
    if (before && data.valor_total < Number(before.valor_empenhado))
      throw new Error(
        "Valor do contrato não pode ser menor que o já empenhado",
      );
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.procurement_contracts set numero=$3, ano=$4,
             fornecedor=$5, fornecedor_documento=$6, objeto=$7, modalidade=$8,
             valor_total=$9, vigencia_inicio=$10, vigencia_fim=$11, status=$12,
             updated_at=now()
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.numero,
            data.ano,
            data.fornecedor,
            data.fornecedor_documento,
            data.objeto,
            data.modalidade,
            data.valor_total,
            data.vigencia_inicio,
            data.vigencia_fim,
            data.status,
          ],
        );
      } else {
        await client.query(
          `insert into public.procurement_contracts
             (id, tenant_id, numero, ano, fornecedor, fornecedor_documento,
              objeto, modalidade, valor_total, vigencia_inicio, vigencia_fim,
              status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            data.tenant_id,
            data.numero,
            data.ano,
            data.fornecedor,
            data.fornecedor_documento,
            data.objeto,
            data.modalidade,
            data.valor_total,
            data.vigencia_inicio,
            data.vigencia_fim,
            data.status,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "procurement_contracts",
        recordId: id,
        before: before ?? null,
        after: data,
      });
    });
    return { id };
  });

const TransitionInput = z.object({
  tenant_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  acao: z.enum(["suspender", "retomar", "encerrar", "rescindir"]),
  motivo: z.string().trim().max(500).optional(),
});

// Estados de origem válidos por ação. 'encerrado'/'rescindido' são terminais.
const TRANSICOES: Record<string, { de: string[]; para: string }> = {
  suspender: { de: ["vigente"], para: "suspenso" },
  retomar: { de: ["suspenso"], para: "vigente" },
  encerrar: { de: ["vigente", "suspenso"], para: "encerrado" },
  rescindir: { de: ["vigente", "suspenso"], para: "rescindido" },
};

// O3-16 — Transiciona o contrato pela máquina de estados (Lei 14.133 art. 137-139):
// vigente ↔ suspenso, e vigente/suspenso → encerrado/rescindido (terminais). A ação só
// vale a partir do estado de origem correto. Reusa contracts.manage.
export const transitionContract = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TransitionInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const contract = (
        await client.query<{ status: string }>(
          `select status from public.procurement_contracts
           where id=$1 and tenant_id=$2 for update`,
          [data.contract_id, data.tenant_id],
        )
      ).rows[0];
      if (!contract) throw new Error("Contrato não encontrado");
      const t = TRANSICOES[data.acao];
      if (!t.de.includes(contract.status))
        throw new Error(
          `Contrato '${contract.status}' não admite a ação '${data.acao}'`,
        );
      await client.query(
        `update public.procurement_contracts set status=$3, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.contract_id, data.tenant_id, t.para],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: `contrato_${data.acao}`,
        resource: "procurement_contracts",
        recordId: data.contract_id,
        after: { status: t.para, motivo: data.motivo ?? null },
      });
      return { id: data.contract_id, status: t.para };
    });
  });
