import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, queryOne, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import {
  loadTenantAccess,
  loadTenantUnitScope,
  requireTenantPermission,
  requireUnitInScope,
} from "./tenant-access.server";

const TenantIdInput = z.object({ tenant_id: z.string().uuid() });

export interface EmploymentLinkView {
  id: string;
  registration_number: string;
  unit_id: string | null;
  unit_name: string | null;
  employment_type: string | null;
  work_regime: string | null;
  job_title: string | null;
  function_title: string | null;
  weekly_hours: number | null;
  cost_center: string | null;
  base_salary: number | null;
  admission_date: string | null;
  termination_date: string | null;
  status: "rascunho" | "ativo" | "afastado" | "ferias" | "desligado";
}

export interface PersonRegistryRow {
  id: string;
  cpf: string | null;
  full_name: string;
  social_name: string | null;
  personal_email: string | null;
  phone: string | null;
  birth_date: string | null;
  mother_name: string | null;
  link_count: number;
  links: EmploymentLinkView[];
}

function requestMetadata() {
  const request = getRequest();
  return {
    requestId: request?.headers?.get("x-request-id") ?? randomUUID(),
    ip: request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
  };
}

const RegistryInput = TenantIdInput.extend({
  search: z.string().trim().max(120).optional().default(""),
  status: z
    .enum(["todos", "rascunho", "ativo", "afastado", "ferias", "desligado"])
    .optional()
    .default("todos"),
});

export const getPeopleRegistry = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => RegistryInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    const scope = await loadTenantUnitScope(access, "people.read");
    const canSensitive = access.permissions.includes("people.sensitive.read");
    const values: unknown[] = [
      data.tenant_id,
      scope.global,
      scope.unitIds,
      canSensitive,
    ];
    let statusSql = "";
    if (data.status !== "todos") {
      values.push(data.status);
      statusSql = `and el.status = $${values.length}`;
    }
    let searchSql = "";
    if (data.search) {
      values.push(`%${data.search}%`);
      searchSql = `and (
        pe.full_name ilike $${values.length}
        or pe.cpf ilike $${values.length}
        or el.registration_number ilike $${values.length}
        or el.job_title ilike $${values.length}
      )`;
    }

    const rows = await query<PersonRegistryRow>(
      `select pe.id,
         case when $4::boolean then pe.cpf
           when pe.cpf is null then null
           else '***.***.***-' || right(regexp_replace(pe.cpf, '\\D', '', 'g'), 2)
         end as cpf,
         pe.full_name, pe.social_name, pe.personal_email, pe.phone,
         case when $4::boolean then pe.birth_date else null end as birth_date,
         case when $4::boolean then pe.mother_name else null end as mother_name,
         count(*)::int as link_count,
         jsonb_agg(jsonb_build_object(
           'id', el.id,
           'registration_number', el.registration_number,
           'unit_id', el.unit_id,
           'unit_name', u.nome,
           'employment_type', el.employment_type,
           'work_regime', el.work_regime,
           'job_title', el.job_title,
           'function_title', el.function_title,
           'weekly_hours', el.weekly_hours,
           'cost_center', el.cost_center,
           'base_salary', el.base_salary,
           'admission_date', el.admission_date,
           'termination_date', el.termination_date,
           'status', el.status
         ) order by el.registration_number) as links
       from public.persons pe
       join public.employment_links el on el.person_id = pe.id
       left join public.unidades u on u.id = el.unit_id and u.tenant_id = el.tenant_id
       where el.tenant_id = $1
         and ($2::boolean or el.unit_id = any($3::uuid[]))
         ${statusSql}
         ${searchSql}
       group by pe.id
       order by pe.full_name
       limit 250`,
      values,
    );
    return {
      people: rows,
      canManage: access.permissions.includes("people.manage"),
      canSensitive,
      scope,
    };
  });

export const getPeopleUnits = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantIdInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    const scope = await loadTenantUnitScope(access, "people.read");
    return query<{ id: string; codigo: string; nome: string; tipo: string }>(
      `select id, codigo, nome, tipo from public.unidades
       where tenant_id = $1 and ativo and ($2::boolean or id = any($3::uuid[]))
       order by nome`,
      [data.tenant_id, scope.global, scope.unitIds],
    );
  });

const SavePersonLinkInput = z.object({
  tenant_id: z.string().uuid(),
  person: z.object({
    id: z.string().uuid().optional(),
    cpf: z.string().trim().max(20).nullable().optional(),
    full_name: z.string().trim().min(2).max(180),
    social_name: z.string().trim().max(180).nullable().optional(),
    birth_date: z.string().date().nullable().optional(),
    mother_name: z.string().trim().max(180).nullable().optional(),
    personal_email: z.string().email().max(255).nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
  }),
  link: z.object({
    id: z.string().uuid().optional(),
    registration_number: z.string().trim().min(1).max(60),
    unit_id: z.string().uuid().nullable(),
    employment_type: z.string().trim().max(80).nullable().optional(),
    work_regime: z.string().trim().max(80).nullable().optional(),
    job_title: z.string().trim().max(140).nullable().optional(),
    function_title: z.string().trim().max(140).nullable().optional(),
    weekly_hours: z.number().positive().max(168).nullable().optional(),
    cost_center: z.string().trim().max(100).nullable().optional(),
    base_salary: z.number().min(0).max(999999999).nullable().optional(),
    admission_date: z.string().date().nullable().optional(),
    termination_date: z.string().date().nullable().optional(),
    status: z.enum(["rascunho", "ativo", "afastado", "ferias", "desligado"]),
  }),
});

function nullable(value: string | null | undefined) {
  return value?.trim() || null;
}

export const savePersonAndLink = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SavePersonLinkInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "people.manage");
    const scope = await loadTenantUnitScope(access, "people.manage");
    requireUnitInScope(scope, data.link.unit_id);

    const cpfDigits = (data.person.cpf ?? "").replace(/\D/g, "");
    if (cpfDigits && cpfDigits.length !== 11)
      throw new Error("CPF deve conter 11 dígitos");
    if (data.link.status === "ativo") {
      if (
        !data.link.unit_id ||
        !nullable(data.link.employment_type) ||
        !nullable(data.link.work_regime) ||
        !nullable(data.link.job_title) ||
        !data.link.weekly_hours ||
        !data.link.admission_date
      ) {
        throw new Error(
          "Para ativar, informe lotação, tipo, regime, cargo, jornada e admissão",
        );
      }
    }

    const unit = data.link.unit_id
      ? await queryOne<{ id: string }>(
          "select id from public.unidades where id = $1 and tenant_id = $2 and ativo",
          [data.link.unit_id, data.tenant_id],
        )
      : null;
    if (data.link.unit_id && !unit)
      throw new Error("Lotação inválida para esta entidade");

    const duplicateRegistration = await queryOne<{ id: string }>(
      `select id from public.employment_links
       where tenant_id = $1 and lower(registration_number) = lower($2)
         and ($3::uuid is null or id <> $3)`,
      [data.tenant_id, data.link.registration_number, data.link.id ?? null],
    );
    if (duplicateRegistration)
      throw new Error("Matrícula já cadastrada nesta entidade");

    let personId = data.person.id ?? null;
    if (!personId && cpfDigits) {
      personId =
        (
          await queryOne<{ id: string }>(
            `select id from public.persons
             where regexp_replace(cpf, '\\D', '', 'g') = $1`,
            [cpfDigits],
          )
        )?.id ?? null;
    }
    personId ??= randomUUID();
    const linkId = data.link.id ?? randomUUID();
    const beforePerson = await queryOne<Record<string, unknown>>(
      "select * from public.persons where id = $1",
      [personId],
    );
    const beforeLink = data.link.id
      ? await queryOne<Record<string, unknown>>(
          "select * from public.employment_links where id = $1 and tenant_id = $2",
          [data.link.id, data.tenant_id],
        )
      : null;
    if (data.link.id && !beforeLink)
      throw new Error("Vínculo não encontrado nesta entidade");

    const canUpdateExistingPerson = beforePerson
      ? Boolean(
          (
            await queryOne<{ ok: boolean }>(
              `select exists(
               select 1 from public.employment_links
               where person_id = $1 and tenant_id = $2
                 and ($3::boolean or unit_id = any($4::uuid[]))
             ) as ok`,
              [personId, data.tenant_id, scope.global, scope.unitIds],
            )
          )?.ok,
        )
      : true;
    const meta = requestMetadata();

    await withTransaction(async (client) => {
      if (!beforePerson) {
        await client.query(
          `insert into public.persons
             (id, cpf, full_name, social_name, birth_date, mother_name, personal_email, phone)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            personId,
            cpfDigits ? data.person.cpf : null,
            data.person.full_name,
            nullable(data.person.social_name),
            access.permissions.includes("people.sensitive.read")
              ? data.person.birth_date || null
              : null,
            access.permissions.includes("people.sensitive.read")
              ? nullable(data.person.mother_name)
              : null,
            nullable(data.person.personal_email),
            nullable(data.person.phone),
          ],
        );
      } else if (canUpdateExistingPerson) {
        await client.query(
          `update public.persons set cpf=$2, full_name=$3, social_name=$4,
             birth_date=case when $9 then $5 else birth_date end,
             mother_name=case when $9 then $6 else mother_name end,
             personal_email=$7, phone=$8
           where id=$1`,
          [
            personId,
            cpfDigits ? data.person.cpf : beforePerson.cpf,
            data.person.full_name,
            nullable(data.person.social_name),
            data.person.birth_date || null,
            nullable(data.person.mother_name),
            nullable(data.person.personal_email),
            nullable(data.person.phone),
            access.permissions.includes("people.sensitive.read"),
          ],
        );
      }

      const params = [
        linkId,
        data.tenant_id,
        personId,
        data.link.registration_number,
        data.link.unit_id,
        nullable(data.link.employment_type),
        nullable(data.link.work_regime),
        nullable(data.link.job_title),
        nullable(data.link.function_title),
        data.link.weekly_hours ?? null,
        nullable(data.link.cost_center),
        data.link.base_salary ?? null,
        data.link.admission_date || null,
        data.link.termination_date || null,
        data.link.status,
      ];
      if (data.link.id) {
        await client.query(
          `update public.employment_links set person_id=$3, registration_number=$4,
             unit_id=$5, employment_type=$6, work_regime=$7, job_title=$8,
             function_title=$9, weekly_hours=$10, cost_center=$11, base_salary=$12,
             admission_date=$13, termination_date=$14, status=$15
           where id=$1 and tenant_id=$2`,
          params,
        );
      } else {
        await client.query(
          `insert into public.employment_links
             (id, tenant_id, person_id, registration_number, unit_id,
              employment_type, work_regime, job_title, function_title,
              weekly_hours, cost_center, base_salary, admission_date,
              termination_date, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          params,
        );
      }

      const after = {
        person: data.person,
        link: data.link,
        person_id: personId,
        link_id: linkId,
      };
      await client.query(
        `insert into public.audit_events
           (tenant_id, actor_id, action, resource, record_id, before_data, after_data, request_id, ip)
         values ($1,$2,$3,'employment_links',$4,$5::jsonb,$6::jsonb,$7,$8::inet)`,
        [
          data.tenant_id,
          context.userId,
          data.link.id ? "update" : "create",
          linkId,
          beforeLink == null
            ? null
            : JSON.stringify({ person: beforePerson, link: beforeLink }),
          JSON.stringify(after),
          meta.requestId,
          meta.ip,
        ],
      );
    });

    return {
      personId,
      linkId,
      reusedPerson: Boolean(beforePerson && !data.person.id),
    };
  });
