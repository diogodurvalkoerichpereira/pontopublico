// O3-02 — Almoxarifado (Onda 3). Catálogo de materiais + movimentação de estoque.
// A saída nunca excede o saldo; entrada/saída atualizam saldo em quantidade e
// valor (custo médio simples). Padrão da casa: createServerFn + guards + auditoria.
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

const round2 = (v: number) => Number(v.toFixed(2));
const round3 = (v: number) => Number(v.toFixed(3));

const TenantInput = z.object({ tenant_id: z.string().uuid() });

export const getMaterialItems = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(TenantInput, data))
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
      estoque_minimo: string;
      status: "ativo" | "inativo";
    }>(
      `select id, codigo, nome, unidade, categoria,
         saldo_quantidade::text, saldo_valor::text, estoque_minimo::text, status
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
  estoque_minimo: z.number().min(0).max(1_000_000_000).default(0),
  status: z.enum(["ativo", "inativo"]).default("ativo"),
});

export const saveMaterialItem = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(SaveItemInput, data))
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
             categoria=$6, estoque_minimo=$7, status=$8, updated_at=now()
           where id=$1 and tenant_id=$2`,
          [
            id,
            data.tenant_id,
            data.codigo,
            data.nome,
            data.unidade,
            data.categoria,
            data.estoque_minimo,
            data.status,
          ],
        );
      } else {
        await client.query(
          `insert into public.material_items
             (id, tenant_id, codigo, nome, unidade, categoria, estoque_minimo,
              status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            data.tenant_id,
            data.codigo,
            data.nome,
            data.unidade,
            data.categoria,
            data.estoque_minimo,
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

const MovementSummaryInput = z.object({
  tenant_id: z.string().uuid(),
  from: z.string().date(),
  to: z.string().date(),
});

// O3-02b — Consolidação da movimentação de material por período. Soma as entradas e as
// saídas (quantidade e valor = quantidade × valor unitário) das movimentações entre `from`
// e `to` (inclusive). Base para o consumo do período (VPD) e a conferência do almoxarifado.
// Reusa materials.read.
export const getMaterialMovementSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(MovementSummaryInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "materials.read");
    if (data.to < data.from)
      throw new Error("A data final não pode anteceder a inicial");
    const row = (
      await query<{
        entradas: string;
        entradas_qtd: string;
        entradas_valor: string;
        saidas: string;
        saidas_qtd: string;
        saidas_valor: string;
      }>(
        `select
           count(*) filter (where tipo='entrada')::text as entradas,
           coalesce(sum(quantidade) filter (where tipo='entrada'),0)::text as entradas_qtd,
           coalesce(sum(quantidade * valor_unitario) filter (where tipo='entrada'),0)::text as entradas_valor,
           count(*) filter (where tipo='saida')::text as saidas,
           coalesce(sum(quantidade) filter (where tipo='saida'),0)::text as saidas_qtd,
           coalesce(sum(quantidade * valor_unitario) filter (where tipo='saida'),0)::text as saidas_valor
         from public.material_movements
         where tenant_id = $1 and data_movimento between $2 and $3`,
        [data.tenant_id, data.from, data.to],
      )
    )[0];
    return {
      periodo: { from: data.from, to: data.to },
      entradas: {
        movimentos: Number(row.entradas),
        quantidade: round3(Number(row.entradas_qtd)),
        valor: round2(Number(row.entradas_valor)),
      },
      saidas: {
        movimentos: Number(row.saidas),
        quantidade: round3(Number(row.saidas_qtd)),
        valor: round2(Number(row.saidas_valor)),
      },
    };
  });

const LedgerInput = z.object({
  tenant_id: z.string().uuid(),
  item_id: z.string().uuid(),
});

// O3-18 — Razão (kardex) do material: relê as movimentações do item em ordem
// cronológica e recompõe o saldo em quantidade a cada linha (entrada soma, saída
// subtrai). É a trilha de auditoria do estoque; o saldo corrente final deve bater
// com o saldo do próprio item. Reusa materials.read.
export const getMaterialLedger = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(LedgerInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "materials.read");
    const item = await queryOne<{
      codigo: string;
      nome: string;
      unidade: string;
      saldo_quantidade: string;
    }>(
      `select codigo, nome, unidade, saldo_quantidade::text
       from public.material_items where id=$1 and tenant_id=$2`,
      [data.item_id, data.tenant_id],
    );
    if (!item) throw new Error("Material não encontrado");
    const rows = await query<{
      id: string;
      tipo: "entrada" | "saida";
      quantidade: string;
      valor_unitario: string;
      data_movimento: string;
      historico: string;
    }>(
      `select id, tipo, quantidade::text, valor_unitario::text,
         data_movimento::text, historico
       from public.material_movements
       where item_id=$1 and tenant_id=$2
       order by data_movimento, created_at, id`,
      [data.item_id, data.tenant_id],
    );
    let saldo = 0;
    const movimentos = rows.map((m) => {
      const qtd = Number(m.quantidade);
      saldo = round3(saldo + (m.tipo === "entrada" ? qtd : -qtd));
      return {
        id: m.id,
        tipo: m.tipo,
        quantidade: qtd,
        valor_unitario: Number(m.valor_unitario),
        data_movimento: m.data_movimento,
        historico: m.historico,
        saldo_quantidade: saldo,
      };
    });
    return {
      item: {
        codigo: item.codigo,
        nome: item.nome,
        unidade: item.unidade,
        saldo_quantidade: Number(item.saldo_quantidade),
      },
      movimentos,
    };
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
  .validator((data: unknown) => parseInput(MovementInput, data))
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
  .validator((data: unknown) => parseInput(TenantInput, data))
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

const AdjustInput = z.object({
  tenant_id: z.string().uuid(),
  item_id: z.string().uuid(),
  quantidade_contada: z.number().min(0).max(1_000_000_000),
  data_ajuste: z.string().date(),
  historico: z.string().trim().min(3).max(500),
});

// O3-02c — Ajuste de inventário (acerto físico). Concilia o saldo do sistema à quantidade
// contada no inventário: apura a diferença e registra uma movimentação de ajuste
// (entrada quando falta no sistema, saída quando sobra), valorada ao custo médio do saldo;
// o saldo passa a ser exatamente o contado. Sem diferença, nada a ajustar. Reusa
// materials.manage.
export const adjustMaterialInventory = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(AdjustInput, data))
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
      const contada = data.quantidade_contada;
      const diferenca = round3(contada - saldoQtd);
      if (diferenca === 0)
        throw new Error("Quantidade contada igual ao saldo — nada a ajustar");
      const custoMedio = saldoQtd > 0 ? saldoValor / saldoQtd : 0;
      const tipo = diferenca > 0 ? "entrada" : "saida";
      const quantidade = Math.abs(diferenca);
      const novaQtd = round3(contada);
      // Ajuste valorado ao custo médio; nunca deixa o valor negativo.
      const novoValor = Math.max(
        0,
        round2(saldoValor + custoMedio * diferenca),
      );

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
          tipo,
          quantidade,
          round2(custoMedio),
          data.data_ajuste,
          `Ajuste de inventario: ${data.historico}`,
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
        action: "ajuste_inventario",
        resource: "material_items",
        recordId: data.item_id,
        after: {
          tipo,
          diferenca,
          saldo_quantidade: novaQtd,
          saldo_valor: novoValor,
        },
      });
      return {
        id,
        tipo,
        diferenca,
        saldo_quantidade: novaQtd,
        saldo_valor: novoValor,
      };
    });
  });

const ReorderInput = z.object({ tenant_id: z.string().uuid() });

// O3-02c — Alerta de reposição do almoxarifado (ponto de pedido). Lista os itens **ativos**
// com estoque mínimo definido (> 0) cujo saldo em estoque caiu ao mínimo ou abaixo, com o
// quanto falta para repor (faltante = mínimo − saldo, nunca negativo). Item sem mínimo (0)
// ou com saldo acima do mínimo não alerta. Read-only, reusa materials.read.
export const getMaterialReorderAlerts = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((data: unknown) => parseInput(ReorderInput, data))
  .handler(async ({ data, context }) => {
    const access = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(access, "materials.read");
    const itens = await query<{
      id: string;
      codigo: string;
      nome: string;
      unidade: string;
      saldo_quantidade: string;
      estoque_minimo: string;
      faltante: string;
    }>(
      `select id, codigo, nome, unidade, saldo_quantidade::text,
         estoque_minimo::text,
         (estoque_minimo - saldo_quantidade)::text as faltante
       from public.material_items
       where tenant_id = $1 and status = 'ativo'
         and estoque_minimo > 0
         and saldo_quantidade <= estoque_minimo
       order by (estoque_minimo - saldo_quantidade) desc, codigo`,
      [data.tenant_id],
    );
    return {
      itens: itens.map((i) => ({
        id: i.id,
        codigo: i.codigo,
        nome: i.nome,
        unidade: i.unidade,
        saldo: Number(i.saldo_quantidade),
        minimo: Number(i.estoque_minimo),
        faltante: Number(Number(i.faltante).toFixed(3)),
      })),
    };
  });
