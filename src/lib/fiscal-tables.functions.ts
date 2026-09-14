// Write-path das tabelas fiscais do ENTE (O1-02a) — habilita RPPS por ente sobre
// o motor do ADR 0003. Espelha payroll-catalog.functions.ts: rascunho→publicada,
// versão publicada imutável, checksum server-side (o loader reconfere), tudo
// auditado. SÓ tabelas do ente: os handlers gravam sempre `tenant_id` do ente
// (nunca nulo) — as nacionais (INSS/IRRF) seguem por migration, não pela app.
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
import { checksumFiscalBrackets } from "./payroll-formula.server";
import type { FiscalBracket } from "./payroll-formula";

const TenantInput = z.object({ tenant_id: z.string().uuid() });

export const getFiscalTables = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TenantInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "fiscal.read");
    // Tabelas do ente + nacionais (tenant nulo) — estas só leitura (governadas
    // por migration). A UI distingue pelo tenant_id nulo.
    const [tables, versions] = await Promise.all([
      query<{
        id: string;
        tenant_id: string | null;
        code: string;
        name: string;
        status: "ativo" | "inativo";
        description: string | null;
      }>(
        `select id,tenant_id,code,name,status,description
         from public.fiscal_tables
         where tenant_id=$1 or tenant_id is null
         order by tenant_id nulls first, lower(code)`,
        [data.tenant_id],
      ),
      query<{
        id: string;
        tenant_id: string | null;
        fiscal_table_id: string;
        version_number: number;
        valid_from: string;
        valid_to: string | null;
        status: "rascunho" | "publicada" | "arquivada";
        brackets: FiscalBracket[];
        checksum: string;
        published_at: string | null;
      }>(
        `select id,tenant_id,fiscal_table_id,version_number,valid_from::text,
           valid_to::text,status,brackets,checksum,published_at::text
         from public.fiscal_table_versions
         where tenant_id=$1 or tenant_id is null
         order by fiscal_table_id,version_number desc`,
        [data.tenant_id],
      ),
    ]);
    return {
      tables,
      versions,
      canManage: access.permissions.includes("fiscal.manage"),
    };
  });

const SaveTableInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]{1,40}$/),
  name: z.string().trim().min(2).max(160),
  status: z.enum(["ativo", "inativo"]),
  description: z.string().trim().max(500).nullable().optional(),
});

export const saveFiscalTable = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveTableInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "fiscal.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.fiscal_tables
       where coalesce(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid)=$1
         and lower(code)=lower($2) and ($3::uuid is null or id<>$3)`,
      [data.tenant_id, data.code, data.id ?? null],
    );
    if (duplicate)
      throw new Error("Código de tabela fiscal já utilizado nesta entidade");
    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          "select * from public.fiscal_tables where id=$1 and tenant_id=$2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Tabela fiscal não encontrada");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.fiscal_tables set code=$3,name=$4,status=$5,description=$6
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.code,
            data.name,
            data.status,
            data.description || null,
          ],
        );
      } else {
        await client.query(
          `insert into public.fiscal_tables
             (id,tenant_id,code,name,status,description,created_by)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            data.tenant_id,
            data.code,
            data.name,
            data.status,
            data.description || null,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "fiscal_tables",
        recordId: id,
        before: before ?? null,
        after: data,
      });
    });
    return { id };
  });

// Faixa: `ate` > 0, `aliquota` em [0,1], `deduzir` >= 0 (só no modo bracket/IRRF).
const BracketInput = z.object({
  ate: z.number().positive().max(1_000_000_000),
  aliquota: z.number().min(0).max(1),
  deduzir: z.number().min(0).max(1_000_000_000).optional(),
});

const SaveVersionInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  fiscal_table_id: z.string().uuid(),
  valid_from: z.string().date(),
  valid_to: z.string().date().nullable().optional(),
  status: z.enum(["rascunho", "publicada", "arquivada"]),
  brackets: z
    .array(BracketInput)
    .min(1)
    .max(50)
    .superRefine((brackets, ctx) => {
      for (let i = 1; i < brackets.length; i += 1) {
        if (brackets[i].ate <= brackets[i - 1].ate) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "As faixas devem ter `ate` estritamente crescente",
          });
          break;
        }
      }
    }),
});

export const saveFiscalTableVersion = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveVersionInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "fiscal.manage");
    if (data.valid_to && data.valid_to < data.valid_from)
      throw new Error("A vigência final não pode anteceder a inicial");
    // Só tabelas do ENTE são geridas pela app (as nacionais têm tenant nulo).
    const table = await queryOne<{ id: string }>(
      "select id from public.fiscal_tables where id=$1 and tenant_id=$2",
      [data.fiscal_table_id, data.tenant_id],
    );
    if (!table) throw new Error("Tabela fiscal inválida para esta entidade");
    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          "select * from public.fiscal_table_versions where id=$1 and tenant_id=$2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Versão não encontrada");
    if (before?.status === "publicada")
      throw new Error("Versão publicada é imutável; crie uma nova versão");
    const checksum = checksumFiscalBrackets(data.brackets as FiscalBracket[]);
    const id = data.id ?? randomUUID();
    const number = data.id
      ? Number(before!.version_number)
      : Number(
          (
            await queryOne<{ next: number }>(
              "select coalesce(max(version_number),0)::int+1 as next from public.fiscal_table_versions where fiscal_table_id=$1",
              [data.fiscal_table_id],
            )
          )?.next ?? 1,
        );
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.fiscal_table_versions set valid_from=$3,valid_to=$4,
             status=$5,brackets=$6::jsonb,checksum=$7,
             published_by=case when $5='publicada' then $8::uuid else published_by end
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.valid_from,
            data.valid_to || null,
            data.status,
            JSON.stringify(data.brackets),
            checksum,
            context.userId,
          ],
        );
      } else {
        await client.query(
          `insert into public.fiscal_table_versions
             (id,tenant_id,fiscal_table_id,version_number,valid_from,valid_to,
              status,brackets,checksum,published_by,created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,
             case when $7='publicada' then $10::uuid else null end,$10)`,
          [
            id,
            data.tenant_id,
            data.fiscal_table_id,
            number,
            data.valid_from,
            data.valid_to || null,
            data.status,
            JSON.stringify(data.brackets),
            checksum,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "fiscal_table_versions",
        recordId: id,
        before: before ?? null,
        after: { ...data, version_number: number, checksum },
      });
    });
    return { id, versionNumber: number, checksum };
  });
