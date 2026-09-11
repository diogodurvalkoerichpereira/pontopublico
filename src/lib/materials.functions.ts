// O3-02 — Almoxarifado (Onda 3). Catálogo de materiais + movimentação de estoque.
// A saída nunca excede o saldo; entrada/saída atualizam saldo em quantidade e
// valor (custo médio simples). Padrão da casa: createServerFn + guards + auditoria.
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

const round2 = (v: number) => Number(v.toFixed(2));
const round3 = (v: number) => Number(v.toFixed(3));

const TenantInput = z.object({ tenant_id: z.string().uuid() });

export const getMaterialItems = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "materials.read");
    const items = await query<{
      id: string;
      codigo: string;
      nome: string;
      unidade: string;
      categoria: "consumo" | "permanente";
      saldo_quantidade: string;
      saldo_valor: string;
      status: "ativo" | "inativo";
    }>(
      `select id, codigo, nome, unidade, categoria,
         saldo_quantidade::text, saldo_valor::text, status
       from public.material_items where tenant_id = $1 order by codigo`,
      [data.tenant_id],
    );
    return {
      items,
      canManage: access.permissions.includes("materials.manage"),
    };
  });

const SaveItemInput = z.object({
  id: z.string().uuid().optional(),
  tenant_id: z.string().uuid(),
  codigo: z.string().trim().min(1).max(40),
  nome: z.string().trim().min(2).max(200),
  unidade: z.string().trim().min(1).max(20),
  categoria: z.enum(["consumo", "permanente"]).default("consumo"),
  status: z.enum(["ativo", "inativo"]).default("ativo"),
});

export const saveMaterialItem = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => SaveItemInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "materials.manage");
    const duplicate = await queryOne<{ id: string }>(
      `select id from public.material_items
       where tenant_id=$1 and lower(codigo)=lower($2)
         and ($3::uuid is null or id<>$3)`,
      [data.tenant_id, data.codigo, data.id ?? null],
    );
    if (duplicate) throw new Error("Código de material já utilizado");
    const id = data.id ?? randomUUID();
    await withTransaction(async (client) => {
      if (data.id) {
        await client.query(
          `update public.material_items set codigo=$3, nome=$4, unidade=$5,
             categoria=$6, status=$7, updated_at=now() where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.codigo,
            data.nome,
            data.unidade,
            data.categoria,
            data.status,
          ],
        );
      } else {
        await client.query(
          `insert into public.material_items
             (id, tenant_id, codigo, nome, unidade, categoria, status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            data.tenant_id,
            data.codigo,
            data.nome,
            data.unidade,
            data.categoria,
            data.status,
            context.userId,
          ],
        );
      }
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.id ? "update" : "create",
        resource: "material_items",
        recordId: id,
        after: data,
      });
    });
    return { id };
  });

const MovementInput = z.object({
  tenant_id: z.string().uuid(),
  item_id: z.string().uuid(),
  tipo: z.enum(["entrada", "saida"]),
  quantidade: z.number().positive().max(1_000_000_000),
  valor_unitario: z.number().min(0).max(1_000_000_000),
  data_movimento: z.string().date(),
  historico: z.string().trim().min(3).max(500),
});

// Movimenta o estoque: entrada soma; saída subtrai e nunca excede o saldo.
export const recordMaterialMovement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => MovementInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "materials.manage");
    return withTransaction(async (client) => {
      const item = (
        await client.query<{
          saldo_quantidade: string;
          saldo_valor: string;
        }>(
          `select saldo_quantidade::text, saldo_valor::text
           from public.material_items where id=$1 and tenant_id=$2 for update`,
          [data.item_id, data.tenant_id],
        )
      ).rows[0];
      if (!item) throw new Error("Material não encontrado");
      const saldoQtd = Number(item.saldo_quantidade);
      const saldoValor = Number(item.saldo_valor);
      const valorMov = round2(data.quantidade * data.valor_unitario);

      let novaQtd: number;
      let novoValor: number;
      if (data.tipo === "entrada") {
        novaQtd = round3(saldoQtd + data.quantidade);
        novoValor = round2(saldoValor + valorMov);
      } else {
        if (data.quantidade > saldoQtd)
          throw new Error(
            `Saída (${data.quantidade}) excede o saldo em estoque (${saldoQtd})`,
          );
        // Baixa a custo médio do saldo.
        const custoMedio = saldoQtd > 0 ? saldoValor / saldoQtd : 0;
        novaQtd = round3(saldoQtd - data.quantidade);
        novoValor = round2(saldoValor - custoMedio * data.quantidade);
      }

      const id = randomUUID();
      await client.query(
        `insert into public.material_movements
           (id, tenant_id, item_id, tipo, quantidade, valor_unitario,
            data_movimento, historico, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          data.tenant_id,
          data.item_id,
          data.tipo,
          data.quantidade,
          data.valor_unitario,
          data.data_movimento,
          data.historico,
          context.userId,
        ],
      );
      await client.query(
        `update public.material_items
         set saldo_quantidade=$3, saldo_valor=$4, updated_at=now()
         where id=$1 and tenant_id=$2`,
        [data.item_id, data.tenant_id, novaQtd, novoValor],
      );
      await recordAudit(client, {
        tenantId: data.tenant_id,
        actorId: context.userId,
        action: data.tipo,
        resource: "material_movements",
        recordId: id,
        after: { item_id: data.item_id, quantidade: data.quantidade },
      });
      return { id, saldo_quantidade: novaQtd, saldo_valor: novoValor };
    });
  });

// O3-17 — Inventário do almoxarifado por categoria (consumo/permanente). Totaliza
// itens e saldos (quantidade e valor) agrupados por categoria, com um total geral.
// Considera apenas material ativo, por ser o acervo vivo do inventário. Reusa
// materials.read. Base para conciliar consumo (VPD) e permanente (patrimônio).
export const getMaterialInventory = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => TenantInput.parse(data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "materials.read");
    const rows = await query<{
      categoria: "consumo" | "permanente";
      itens: string;
      saldo_quantidade: string;
      saldo_valor: string;
    }>(
      `select categoria, count(*)::text as itens,
         coalesce(sum(saldo_quantidade),0)::text as saldo_quantidade,
         coalesce(sum(saldo_valor),0)::text as saldo_valor
       from public.material_items
       where tenant_id = $1 and status = 'ativo'
       group by categoria order by categoria`,
      [data.tenant_id],
    );
    const categorias = rows.map((r) => ({
      categoria: r.categoria,
      itens: Number(r.itens),
      saldo_quantidade: round3(Number(r.saldo_quantidade)),
      saldo_valor: round2(Number(r.saldo_valor)),
    }));
    const total = {
      itens: categorias.reduce((s, c) => s + c.itens, 0),
      saldo_quantidade: round3(
        categorias.reduce((s, c) => s + c.saldo_quantidade, 0),
      ),
      saldo_valor: round2(categorias.reduce((s, c) => s + c.saldo_valor, 0)),
    };
    return { categorias, total };
  });
