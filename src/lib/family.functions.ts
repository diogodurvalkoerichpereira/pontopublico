import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  loadTenantUnitScope,
  requireTenantPermission,
  requireUnitInScope,
} from "./tenant-access.server";

async function assertPersonScope(
  tenantId: string,
  personId: string,
  userId: string,
  permission: "family.read" | "family.manage",
) {
  const access = await loadTenantAccess(userId, tenantId);
  const scope = await loadTenantUnitScope(access, permission);
  const link = await queryOne<{ unit_id: string | null }>(
    `select unit_id from public.employment_links
     where tenant_id=$1 and person_id=$2
       and ($3::boolean or unit_id=any($4::uuid[]))
     order by status='ativo' desc, created_at limit 1`,
    [tenantId, personId, scope.global, scope.unitIds],
  );
  if (!link) throw new Error("Pessoa fora do seu escopo organizacional");
  return { access, scope };
}

const WorkspaceInput = z.object({
  tenant_id: z.string().uuid(),
  holder_person_id: z.string().uuid(),
});

export const getFamilyWorkspace = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => WorkspaceInput.parse(data))
  .handler(async ({ data, context }) => {
    const { access, scope } = await assertPersonScope(
      data.tenant_id,
      data.holder_person_id,
      context.userId,
      "family.read",
    );
    const [holder, dependents, links, pensions] = await Promise.all([
      queryOne<{ id: string; full_name: string; cpf: string | null }>(
        "select id, full_name, cpf from public.persons where id=$1",
        [data.holder_person_id],
      ),
      query<{
        id: string;
        dependent_person_id: string;
        full_name: string;
        cpf: string | null;
        relationship: string;
        income_tax_effect: boolean;
        social_security_effect: boolean;
        valid_from: string;
        valid_to: string | null;
      }>(
        `select d.id, d.dependent_person_id, p.full_name, p.cpf,
           d.relationship, d.income_tax_effect, d.social_security_effect,
           d.valid_from::text, d.valid_to::text
         from public.person_dependents d
         join public.persons p on p.id=d.dependent_person_id
         where d.tenant_id=$1 and d.holder_person_id=$2
         order by d.valid_from desc, p.full_name`,
        [data.tenant_id, data.holder_person_id],
      ),
      query<{
        id: string;
        registration_number: string;
        unit_id: string | null;
      }>(
        `select id, registration_number, unit_id from public.employment_links
         where tenant_id=$1 and person_id=$2
           and ($3::boolean or unit_id=any($4::uuid[]))
         order by registration_number`,
        [data.tenant_id, data.holder_person_id, scope.global, scope.unitIds],
      ),
      query<{
        id: string;
        employment_link_id: string;
        beneficiary_person_id: string;
        full_name: string;
        cpf: string | null;
        calculation_type: "percentual" | "valor_fixo";
        percentage: number | null;
        fixed_amount: number | null;
        priority: number;
        valid_from: string;
        valid_to: string | null;
        legal_basis: string | null;
      }>(
        `select pb.id, pb.employment_link_id, pb.beneficiary_person_id,
           p.full_name, p.cpf, pb.calculation_type, pb.percentage,
           pb.fixed_amount, pb.priority, pb.valid_from::text,
           pb.valid_to::text, pb.legal_basis
         from public.pension_beneficiaries pb
         join public.persons p on p.id=pb.beneficiary_person_id
         join public.employment_links el on el.id=pb.employment_link_id
         where pb.tenant_id=$1 and el.person_id=$2
           and ($3::boolean or el.unit_id=any($4::uuid[]))
         order by pb.priority, p.full_name`,
        [data.tenant_id, data.holder_person_id, scope.global, scope.unitIds],
      ),
    ]);
    return {
      holder,
      dependents,
      links,
      pensions,
      canManage: access.permissions.includes("family.manage"),
    };
  });

const PersonInput = z.object({
  full_name: z.string().trim().min(2).max(180),
  cpf: z.string().trim().max(20).nullable().optional(),
  birth_date: z.string().date().nullable().optional(),
});

const SaveDependentInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  holder_person_id: z.string().uuid(),
  dependent: PersonInput,
  relationship: z.string().trim().min(2).max(80),
  income_tax_effect: z.boolean(),
  social_security_effect: z.boolean(),
  valid_from: z.string().date(),
  valid_to: z.string().date().nullable().optional(),
});

async function resolvePerson(
  client: import("pg").PoolClient,
  person: z.infer<typeof PersonInput>,
) {
  const cpfDigits = (person.cpf ?? "").replace(/\D/g, "");
  if (cpfDigits && cpfDigits.length !== 11)
    throw new Error("CPF deve conter 11 dígitos");
  if (cpfDigits) {
    const current = await client.query<{ id: string }>(
      "select id from public.persons where regexp_replace(cpf,'\\D','','g')=$1 limit 1",
      [cpfDigits],
    );
    if (current.rows[0]) return { id: current.rows[0].id, reused: true };
  }
  const id = randomUUID();
  await client.query(
    `insert into public.persons (id, cpf, full_name, birth_date)
     values ($1,$2,$3,$4)`,
    [
      id,
      cpfDigits ? person.cpf : null,
      person.full_name,
      person.birth_date || null,
    ],
  );
  return { id, reused: false };
}

export const saveDependent = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveDependentInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertPersonScope(
      data.tenant_id,
      data.holder_person_id,
      context.userId,
      "family.manage",
    );
    if (data.valid_to && data.valid_to < data.valid_from)
      throw new Error("A vigência final não pode anteceder a inicial");
    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          "select * from public.person_dependents where id=$1 and tenant_id=$2 and holder_person_id=$3",
          [data.id, data.tenant_id, data.holder_person_id],
        )
      : null;
    if (data.id && !before) throw new Error("Dependente não encontrado");
    const id = data.id ?? randomUUID();
    let reused = false;
    await withTransaction(async (client) => {
      const resolved = data.id
        ? { id: String(before!.dependent_person_id), reused: true }
        : await resolvePerson(client, data.dependent);
      reused = resolved.reused;
      if (resolved.id === data.holder_person_id)
        throw new Error("Titular e dependente não podem ser a mesma pessoa");
      if (data.id) {
        await client.query(
          `update public.person_dependents set relationship=$4,
             income_tax_effect=$5, social_security_effect=$6,
             valid_from=$7, valid_to=$8 where id=$1 and tenant_id=$2 and holder_person_id=$3`,
          [
            id,
            data.tenant_id,
            data.holder_person_id,
            data.relationship,
            data.income_tax_effect,
            data.social_security_effect,
            data.valid_from,
            data.valid_to || null,
          ],
        );
      } else {
        await client.query(
          `insert into public.person_dependents
             (id,tenant_id,holder_person_id,dependent_person_id,relationship,
              income_tax_effect,social_security_effect,valid_from,valid_to,created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            data.tenant_id,
            data.holder_person_id,
            resolved.id,
            data.relationship,
            data.income_tax_effect,
            data.social_security_effect,
            data.valid_from,
            data.valid_to || null,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "person_dependents",
        recordId: id,
        before: before ?? null,
        after: data,
      });
    });
    return { id, reusedPerson: reused };
  });

const SavePensionInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  holder_person_id: z.string().uuid(),
  employment_link_id: z.string().uuid(),
  beneficiary: PersonInput,
  calculation_type: z.enum(["percentual", "valor_fixo"]),
  percentage: z.number().positive().max(100).nullable().optional(),
  fixed_amount: z.number().positive().nullable().optional(),
  priority: z.number().int().min(1).max(999),
  valid_from: z.string().date(),
  valid_to: z.string().date().nullable().optional(),
  legal_basis: z.string().trim().max(500).nullable().optional(),
});

export const savePensionBeneficiary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SavePensionInput.parse(data))
  .handler(async ({ data, context }) => {
    const { scope } = await assertPersonScope(
      data.tenant_id,
      data.holder_person_id,
      context.userId,
      "family.manage",
    );
    const link = await queryOne<{ unit_id: string | null; person_id: string }>(
      "select unit_id, person_id from public.employment_links where id=$1 and tenant_id=$2",
      [data.employment_link_id, data.tenant_id],
    );
    if (!link || link.person_id !== data.holder_person_id)
      throw new Error("Vínculo de origem inválido");
    requireUnitInScope(scope, link.unit_id);
    if (data.valid_to && data.valid_to < data.valid_from)
      throw new Error("A vigência final não pode anteceder a inicial");
    const exclusive =
      (data.calculation_type === "percentual" &&
        data.percentage &&
        !data.fixed_amount) ||
      (data.calculation_type === "valor_fixo" &&
        data.fixed_amount &&
        !data.percentage);
    if (!exclusive)
      throw new Error(
        "Informe somente percentual ou valor fixo, conforme o tipo",
      );
    const before = data.id
      ? await queryOne<Record<string, unknown>>(
          "select * from public.pension_beneficiaries where id=$1 and tenant_id=$2",
          [data.id, data.tenant_id],
        )
      : null;
    if (data.id && !before) throw new Error("Pensionista não encontrado");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      const resolved = data.id
        ? { id: String(before!.beneficiary_person_id), reused: true }
        : await resolvePerson(client, data.beneficiary);
      const values = [
        id,
        data.tenant_id,
        data.employment_link_id,
        resolved.id,
        data.calculation_type,
        data.calculation_type === "percentual" ? data.percentage : null,
        data.calculation_type === "valor_fixo" ? data.fixed_amount : null,
        data.priority,
        data.valid_from,
        data.valid_to || null,
        data.legal_basis || null,
        context.userId,
      ];
      if (data.id) {
        await client.query(
          `update public.pension_beneficiaries set employment_link_id=$3,
             calculation_type=$5,percentage=$6,fixed_amount=$7,priority=$8,
             valid_from=$9,valid_to=$10,legal_basis=$11 where id=$1 and tenant_id=$2`,
          values,
        );
      } else {
        await client.query(
          `insert into public.pension_beneficiaries
             (id,tenant_id,employment_link_id,beneficiary_person_id,
              calculation_type,percentage,fixed_amount,priority,valid_from,
              valid_to,legal_basis,created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          values,
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "pension_beneficiaries",
        recordId: id,
        before: before ?? null,
        after: data,
      });
    });
    return { id };
  });
