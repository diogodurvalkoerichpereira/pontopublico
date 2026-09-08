/**
 * Exportações para órgãos de controle.
 *
 * ATENÇÃO — nenhum layout oficial está implementado aqui. Três dos quatro
 * códigos (TCE-CE SIM, SIOPE e MANAD) produzem exatamente o MESMO CSV de cinco
 * colunas — matrícula, CPF, bruto, descontos, líquido — e o quarto (PCS) produz
 * um XML de estrutura própria. Os layouts reais têm dezenas a centenas de
 * campos, cada um com estrutura distinta, e são publicados pelos respectivos
 * órgãos.
 *
 * Por isso os códigos carregam o prefixo RASCUNHO_: o arquivo gerado serve para
 * conferência interna, não para entrega ao órgão, e não pode sustentar
 * declaração de conformidade em licitação. Ver src/lib/conformance.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import { conformanceOf } from "./conformance";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";
const I = z.object({
  tenant_id: z.string().uuid(),
  code: z.enum([
    "RASCUNHO_TCE_CE_SIM",
    "RASCUNHO_SIOPE",
    "RASCUNHO_MANAD",
    "RASCUNHO_PCS",
  ]),
  version: z.string(),
  reference_month: z.string().regex(/^\d{4}-\d{2}$/),
});
export const generateOfficialExport = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((v: unknown) => I.parse(v))
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "official.export.manage");
    return withTransaction(async (c) => {
      let l = (
        await c.query<any>(
          `select id from public.official_export_layouts where code=$1 and version=$2`,
          [data.code, data.version],
        )
      ).rows[0];
      if (!l) {
        l = { id: randomUUID() };
        await c.query(
          `insert into public.official_export_layouts(id,code,version,effective_from,schema_definition)values($1,$2,$3,$4,$5::jsonb)`,
          [
            l.id,
            data.code,
            data.version,
            data.reference_month + "-01",
            JSON.stringify({
              required: ["matricula", "cpf", "bruto", "descontos", "liquido"],
              conformidade: conformanceOf("exportacao-oficial"),
            }),
          ],
        );
      }
      const rows = (
        await c.query<any>(
          `select link.registration_number matricula,person.cpf,result.earnings bruto,result.deductions descontos,result.net_amount liquido from public.payroll_cycles cycle join public.payroll_cycle_results result on result.cycle_id=cycle.id join public.employment_links link on link.id=result.employment_link_id join public.persons person on person.id=link.person_id where cycle.tenant_id=$1 and cycle.reference_month=$2 and cycle.cycle_type='mensal' and cycle.status='fechada' order by link.registration_number`,
          [data.tenant_id, data.reference_month + "-01"],
        )
      ).rows;
      const errors: string[] = [];
      if (!rows.length) errors.push("FOLHA_FECHADA_NAO_ENCONTRADA");
      rows.forEach((r: any, i: number) => {
        if (!r.cpf || !r.matricula)
          errors.push(`LINHA_${i + 1}_CADASTRO_INCOMPLETO`);
      });
      const content =
        data.code === "RASCUNHO_PCS"
          ? `<pcs versao="${data.version}">${rows.map((r: any) => `<servidor matricula="${r.matricula}" cpf="${r.cpf}" liquido="${r.liquido}"/>`).join("")}</pcs>`
          : rows
              .map((r: any) =>
                [r.matricula, r.cpf, r.bruto, r.descontos, r.liquido].join(";"),
              )
              .join("\r\n");
      const hash = createHash("sha256").update(content).digest("hex"),
        id = randomUUID();
      await c.query(
        `insert into public.official_export_batches(id,tenant_id,layout_id,reference_month,status,records_count,file_content,file_sha256,validation_errors,created_by)values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [
          id,
          data.tenant_id,
          l.id,
          data.reference_month + "-01",
          errors.length ? "invalido" : "valido",
          rows.length,
          content,
          hash,
          JSON.stringify(errors),
          context.userId,
        ],
      );
      // Trilha de auditoria do ato de saída de dados (exportação oficial).
      await recordAudit(c, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "exportacao.gerar",
        resource: "official_export_batches",
        recordId: id,
        after: {
          code: data.code,
          version: data.version,
          reference_month: data.reference_month,
          status: errors.length ? "invalido" : "valido",
          records_count: rows.length,
          file_sha256: hash,
          validation_errors: errors,
        },
      });
      return {
        id,
        content,
        errors,
        hash,
        conformidade: conformanceOf("exportacao-oficial"),
      };
    });
  });
