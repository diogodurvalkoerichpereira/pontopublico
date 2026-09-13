// O4-06 — ITBI sobre transmissão de imóvel (Onda 4). O imposto de transmissão
// inter vivos incide sobre o VALOR DA TRANSMISSÃO (não o venal), na alíquota do
// ente. Gera um crédito tributário (tax_credits, O4-01) por transmissão, com
// inscrição "inscricao_imobiliaria/ITBI/data" (único por transmissão). Reusa
// taxes.* e o cadastro imobiliário (O4-04).
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const Input = z.object({
  tenant_id: z.string().uuid(),
  property_id: z.string().uuid(),
  adquirente: z.string().trim().min(2).max(200),
  adquirente_documento: z.string().trim().min(3).max(20),
  valor_transmissao: z.number().positive().max(1_000_000_000_000),
  aliquota: z.number().positive().max(10),
  data_transmissao: z.string().date(),
  vencimento: z.string().date(),
});

// Lança o ITBI de uma transmissão: crédito = base de cálculo × alíquota (%).
// O4-06b — a base é a MAIOR entre o valor declarado da transmissão e o valor
// venal do imóvel (arbitramento, CTN art. 148): declarar abaixo do venal não
// reduz o imposto. Devolve `base_calculo` e `arbitrado` (base veio do venal).
export const launchItbi = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "taxes.manage");
    const exercicio = Number(data.data_transmissao.slice(0, 4));
    return withTransaction(async (client) => {
      const property = (
        await client.query<{
          inscricao_imobiliaria: string;
          status: string;
          valor_venal: string;
        }>(
          `select inscricao_imobiliaria, status, valor_venal::text
           from public.real_estate_properties where id=$1 and tenant_id=$2`,
          [data.property_id, data.tenant_id],
        )
      ).rows[0];
      if (!property) throw new Error("Imóvel não encontrado");
      if (property.status !== "ativo")
        throw new Error("Imóvel baixado não gera ITBI");
      const inscricao = `${property.inscricao_imobiliaria}/ITBI/${data.data_transmissao}`;
      const dup = await client.query(
        `select id from public.tax_credits
         where tenant_id=$1 and tributo='ITBI' and exercicio=$2
           and lower(inscricao)=lower($3)`,
        [data.tenant_id, exercicio, inscricao],
      );
      if (dup.rows.length)
        throw new Error("ITBI já lançado para esta transmissão");
      // Base arbitrada: o venal prevalece quando o declarado fica abaixo dele.
      const valorVenal = Number(property.valor_venal);
      const arbitrado = valorVenal > data.valor_transmissao;
      const baseCalculo = arbitrado ? valorVenal : data.valor_transmissao;
      const valor = Number(((baseCalculo * data.aliquota) / 100).toFixed(2));
      if (valor <= 0) throw new Error("Valor do ITBI calculado é zero");
      const creditId = randomUUID();
      await client.query(
        `insert into public.tax_credits
           (id, tenant_id, tributo, exercicio, contribuinte, contribuinte_documento,
            inscricao, valor_lancado, vencimento, created_by)
         values ($1,$2,'ITBI',$3,$4,$5,$6,$7,$8,$9)`,
        [
          creditId,
          data.tenant_id,
          exercicio,
          data.adquirente,
          data.adquirente_documento,
          inscricao,
          valor,
          data.vencimento,
          context.userId,
        ],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "launch_itbi",
        resource: "tax_credits",
        recordId: creditId,
        after: {
          property_id: data.property_id,
          valor_transmissao: data.valor_transmissao,
          valor_venal: valorVenal,
          base_calculo: baseCalculo,
          arbitrado,
          aliquota: data.aliquota,
          valor,
        },
      });
      return {
        credit_id: creditId,
        valor,
        base_calculo: baseCalculo,
        arbitrado,
      };
    });
  });
