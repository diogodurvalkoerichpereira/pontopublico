import { createServerFn } from "@tanstack/react-start";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  loadTenantUnitScope,
  requireUnitInScope,
} from "./tenant-access.server";

const STORAGE_DIR = process.env.STORAGE_DIR || "/data/storage";

const WorkspaceInput = z.object({ tenant_id: z.string().uuid() });

export const getMovementWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(WorkspaceInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    const scope = await loadTenantUnitScope(access, "movements.read");
    const [links, units, movements] = await Promise.all([
      query<{
        id: string;
        person_id: string;
        full_name: string;
        registration_number: string;
        unit_id: string | null;
        unit_name: string | null;
        status: string;
      }>(
        `select el.id, el.person_id, p.full_name, el.registration_number,
           el.unit_id, u.nome as unit_name, el.status
         from public.employment_links el
         join public.persons p on p.id=el.person_id
         left join public.unidades u on u.id=el.unit_id
         where el.tenant_id=$1 and ($2::boolean or el.unit_id=any($3::uuid[]))
         order by p.full_name, el.registration_number`,
        [data.tenant_id, scope.global, scope.unitIds],
      ),
      query<{ id: string; codigo: string; nome: string }>(
        `select id,codigo,nome from public.unidades
         where tenant_id=$1 and ativo and ($2::boolean or id=any($3::uuid[]))
         order by nome`,
        [data.tenant_id, scope.global, scope.unitIds],
      ),
      query<{
        id: string;
        employment_link_id: string;
        movement_type: string;
        effective_date: string;
        from_unit_name: string | null;
        to_unit_name: string | null;
        from_status: string | null;
        to_status: string | null;
        legal_basis: string;
        document_path: string | null;
        document_sha256: string | null;
        notes: string | null;
        applied_at: string | null;
        created_at: string;
      }>(
        `select m.id,m.employment_link_id,m.movement_type,m.effective_date::text,
           source.nome as from_unit_name,target.nome as to_unit_name,
           m.from_status,m.to_status,m.legal_basis,m.document_path,
           m.document_sha256,m.notes,m.applied_at::text,m.created_at::text
         from public.employment_link_movements m
         join public.employment_links el on el.id=m.employment_link_id
         left join public.unidades source on source.id=m.from_unit_id
         left join public.unidades target on target.id=m.to_unit_id
         where m.tenant_id=$1 and ($2::boolean or el.unit_id=any($3::uuid[]))
         order by m.effective_date desc,m.created_at desc`,
        [data.tenant_id, scope.global, scope.unitIds],
      ),
    ]);
    return {
      links,
      units,
      movements,
      canManage: access.permissions.includes("movements.manage"),
    };
  });

const SaveMovementInput = z.object({
  tenant_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  movement_type: z.enum([
    "admissao",
    "lotacao",
    "afastamento",
    "cessao",
    "retorno",
    "desligamento",
  ]),
  effective_date: z.string().date(),
  to_unit_id: z.string().uuid().nullable().optional(),
  to_status: z
    .enum(["rascunho", "ativo", "afastado", "ferias", "desligado"])
    .nullable()
    .optional(),
  legal_basis: z.string().trim().min(2).max(500),
  notes: z.string().trim().max(1000).nullable().optional(),
  document: z
    .object({
      name: z.string().trim().min(1).max(180),
      base64: z.string().min(1).max(15_000_000),
    })
    .nullable()
    .optional(),
});

function safeName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-120);
}

export const saveEmploymentMovement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveMovementInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    const scope = await loadTenantUnitScope(access, "movements.manage");
    const link = await queryOne<{
      id: string;
      unit_id: string | null;
      status: string;
      person_id: string;
    }>(
      "select id,unit_id,status,person_id from public.employment_links where id=$1 and tenant_id=$2",
      [data.employment_link_id, data.tenant_id],
    );
    if (!link) throw new Error("Vínculo não encontrado");
    requireUnitInScope(scope, link.unit_id);
    if (data.to_unit_id) requireUnitInScope(scope, data.to_unit_id);
    if (data.movement_type === "lotacao" && !data.to_unit_id)
      throw new Error("Informe a nova lotação");

    const movementId = randomUUID();
    let documentPath: string | null = null;
    let documentHash: string | null = null;
    if (data.document) {
      const buffer = Buffer.from(data.document.base64, "base64");
      documentHash = createHash("sha256").update(buffer).digest("hex");
      documentPath = `${data.tenant_id}/${data.employment_link_id}/${movementId}-${safeName(data.document.name)}`;
      const destination = join(STORAGE_DIR, "movement-documents", documentPath);
      await fs.mkdir(join(destination, ".."), { recursive: true });
      await fs.writeFile(destination, buffer);
    }

    const today = new Date().toISOString().slice(0, 10);
    const applyNow = data.effective_date <= today;
    const targetStatus =
      data.to_status ??
      (data.movement_type === "afastamento" || data.movement_type === "cessao"
        ? "afastado"
        : data.movement_type === "retorno" || data.movement_type === "admissao"
          ? "ativo"
          : data.movement_type === "desligamento"
            ? "desligado"
            : link.status);
    const after = {
      unit_id: data.to_unit_id ?? link.unit_id,
      status: targetStatus,
    };

    await withTransaction(async (client) => {
      await client.query(
        `insert into public.employment_link_movements
           (id,tenant_id,employment_link_id,movement_type,effective_date,
            from_unit_id,to_unit_id,from_status,to_status,before_data,after_data,
            legal_basis,document_path,document_sha256,notes,applied_at,created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,
           $12,$13,$14,$15,case when $16 then now() else null end,$17)`,
        [
          movementId,
          data.tenant_id,
          data.employment_link_id,
          data.movement_type,
          data.effective_date,
          link.unit_id,
          data.to_unit_id ?? null,
          link.status,
          targetStatus,
          JSON.stringify({ unit_id: link.unit_id, status: link.status }),
          JSON.stringify(after),
          data.legal_basis,
          documentPath,
          documentHash,
          data.notes || null,
          applyNow,
          context.userId,
        ],
      );
      if (applyNow) {
        await client.query(
          `update public.employment_links set
             unit_id=case when $3::uuid is null then unit_id else $3 end,
             status=$4,
             termination_date=case when $5='desligamento' then $6::date else termination_date end
           where id=$1 and tenant_id=$2`,
          [
            data.employment_link_id,
            data.tenant_id,
            data.to_unit_id ?? null,
            targetStatus,
            data.movement_type,
            data.effective_date,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "create",
        resource: "employment_link_movements",
        recordId: movementId,
        before: { unit_id: link.unit_id, status: link.status },
        after: {
          ...after,
          effective_date: data.effective_date,
          document_path: documentPath,
          document_sha256: documentHash,
        },
      });
    });
    return { id: movementId, applied: applyNow, documentHash };
  });

const ApplyDueInput = z.object({
  tenant_id: z.string().uuid(),
  data_referencia: z.string().date(),
});

// Aplica os atos de pessoal **programados** cuja data de efeito já chegou. Um movimento
// registrado com `effective_date` futura fica pendente (`applied_at` nulo) e não altera o
// vínculo — nada o aplicava depois. Esta rotina, na data de referência, aplica cada
// pendente vencido (effective_date ≤ referência) em ordem cronológica: atualiza a lotação,
// a situação e a data de desligamento do vínculo e carimba `applied_at`. Respeita o escopo
// por unidade e reusa `movements.manage`.
export const applyDueEmploymentMovements = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(ApplyDueInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    const scope = await loadTenantUnitScope(access, "movements.manage");
    return withTransaction(async (client) => {
      const pending = (
        await client.query<{
          id: string;
          employment_link_id: string;
          movement_type: string;
          effective_date: string;
          to_unit_id: string | null;
          to_status: string | null;
          from_unit_id: string | null;
          from_status: string | null;
        }>(
          `select m.id, m.employment_link_id, m.movement_type, m.effective_date::text,
             m.to_unit_id, m.to_status, m.from_unit_id, m.from_status
           from public.employment_link_movements m
           join public.employment_links el on el.id=m.employment_link_id
           where m.tenant_id=$1 and m.applied_at is null
             and m.effective_date <= $2::date
             and ($3::boolean or el.unit_id = any($4::uuid[]))
           order by m.effective_date, m.created_at
           for update of m`,
          [data.tenant_id, data.data_referencia, scope.global, scope.unitIds],
        )
      ).rows;

      for (const m of pending) {
        await client.query(
          `update public.employment_links set
             unit_id=case when $3::uuid is null then unit_id else $3 end,
             status=case when $4::text is null then status else $4 end,
             termination_date=case when $5='desligamento' then $6::date else termination_date end
           where id=$1 and tenant_id=$2`,
          [
            m.employment_link_id,
            data.tenant_id,
            m.to_unit_id,
            m.to_status,
            m.movement_type,
            m.effective_date,
          ],
        );
        await client.query(
          `update public.employment_link_movements set applied_at=now()
           where id=$1 and tenant_id=$2`,
          [m.id, data.tenant_id],
        );
        await recordAudit(client, {
          tenantId: data.tenant_id,
          actorId: context.userId,
          action: "apply",
          resource: "employment_link_movements",
          recordId: m.id,
          before: { unit_id: m.from_unit_id, status: m.from_status },
          after: {
            unit_id: m.to_unit_id,
            status: m.to_status,
            effective_date: m.effective_date,
          },
        });
      }
      return { aplicados: pending.length };
    });
  });
