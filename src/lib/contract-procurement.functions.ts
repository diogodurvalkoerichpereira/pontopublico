// O3-09 — Vínculo do contrato à licitação de origem (Onda 3, Lei 14.133). Todo
// contrato decorre de um processo licitatório: aqui o contrato passa a referenciar
// a licitação HOMOLOGADA que o originou, com modalidade coerente. Reusa contracts.*.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { withTransaction } from "./db.server";
import { requireAuth } from "./data.functions";
import { recordAudit } from "./audit.server";
import {
  loadTenantAccess,
  requireTenantPermission,
} from "./tenant-access.server";

const LinkInput = z.object({
  tenant_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  process_id: z.string().uuid(),
});

// Liga o contrato à licitação de origem. Só uma licitação homologada, do mesmo
// ente e com a mesma modalidade do contrato, pode originá-lo.
export const linkContractToProcurement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => LinkInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "contracts.manage");
    return withTransaction(async (client) => {
      const contract = (
        await client.query<{ modalidade: string; status: string }>(
          `select modalidade, status from public.procurement_contracts
           where id=$1 and tenant_id=$2 for update`,
          [data.contract_id, data.tenant_id],
        )
      ).rows[0];
      if (!contract) throw new Error("Contrato não encontrado");
      const process = (
        await client.query<{ modalidade: string; status: string }>(
          `select modalidade, status from public.procurement_processes
           where id=$1 and tenant_id=$2`,
          [data.process_id, data.tenant_id],
        )
      ).rows[0];
      if (!process) throw new Error("Licitação não encontrada");
      if (process.status !== "homologada")
        throw new Error("Só uma licitação homologada pode originar contrato");
      if (process.modalidade !== contract.modalidade)
        throw new Error(
          "A modalidade do contrato deve coincidir com a da licitação",
        );
      await client.query(
        `update public.procurement_contracts
         set procurement_process_id=$3, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.contract_id, data.tenant_id, data.process_id],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: "link_procurement",
        resource: "procurement_contracts",
        recordId: data.contract_id,
        after: { procurement_process_id: data.process_id },
      });
      return { id: data.contract_id, procurement_process_id: data.process_id };
    });
  });
