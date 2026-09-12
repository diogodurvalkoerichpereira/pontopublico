// Compilador de QueryReq -> SQL parametrizado, com autorização por linha
// portada das RLS originais do Supabase. SOMENTE servidor.
import { query, queryOne } from "./db.server";
import type { QueryReq, QueryFilter, QueryResult } from "./pgrest-types";

// Estratégia de isolamento por tenant de cada tabela legada. União discriminada
// de propósito: uma tabela nova sem entrada aqui NÃO COMPILA — é a diferença
// entre lembrar de filtrar e não conseguir esquecer.
//   - direct:     a tabela tem coluna tenant_id (só `unidades` hoje).
//   - via_member: escopo indireto pelos membros do ente
//                 (col IN (SELECT user_id FROM tenant_memberships ...)).
//   - global:     catálogo/sem dono, ou tabela de papéis globais lida no
//                 bootstrap antes de haver tenant ativo.
type TenantStrategy =
  | { strategy: "direct"; column: string }
  | { strategy: "via_member"; column: string }
  | { strategy: "global" };

const TABLE_REGISTRY = {
  unidades: { strategy: "direct", column: "tenant_id" },
  profiles: { strategy: "via_member", column: "id" },
  atestados: { strategy: "via_member", column: "user_id" },
  notifications: { strategy: "via_member", column: "user_id" },
  employee_documents: { strategy: "via_member", column: "user_id" },
  document_checklist: { strategy: "via_member", column: "user_id" },
  time_entries: { strategy: "via_member", column: "user_id" },
  // payroll_periods (folha legada) foi congelada no O0-13: sem registro aqui, o
  // shim não a alcança — vira arquivo read-only. A folha válida é payroll_cycles.
  audit_logs: { strategy: "via_member", column: "actor_id" },
  user_roles: { strategy: "global" }, // papéis globais; lido no bootstrap do login
  rh_permissions: { strategy: "global" }, // idem
  work_schedules: { strategy: "global" }, // catálogo, sem coluna de dono
  // payroll_config (faixas INSS/IRRF do singleton legado) foi congelada no
  // O1-01b: sem registro aqui, o shim não a alcança — arquivo read-only. A fonte
  // fiscal viva é fiscal_tables (versionada, com checksum). Ver ADR 0003 e 0017.
} as const satisfies Record<string, TenantStrategy>;

function tableStrategy(table: string): TenantStrategy | null {
  return (TABLE_REGISTRY as Record<string, TenantStrategy>)[table] ?? null;
}

// Relações to-one suportadas em select embutido (ex: "*, work_schedules(*)").
const EMBEDS: Record<
  string,
  Record<string, { localCol: string; refTable: string }>
> = {
  profiles: {
    work_schedules: { localCol: "schedule_id", refTable: "work_schedules" },
    unidades: { localCol: "unidade_id", refTable: "unidades" },
  },
};

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  const n = name.trim();
  if (!IDENT_RE.test(n)) throw new Error(`Identificador inválido: ${name}`);
  return `"${n}"`;
}

export interface AccessCtx {
  userId: string;
  roles: string[];
  perms: string[];
}

export async function loadAccess(userId: string): Promise<AccessCtx> {
  const roles = (
    await query<{ role: string }>(
      "SELECT role FROM public.user_roles WHERE user_id = $1",
      [userId],
    )
  ).map((r) => r.role);
  const perms = (
    await query<{ permission: string }>(
      "SELECT permission FROM public.rh_permissions WHERE user_id = $1",
      [userId],
    )
  ).map((r) => r.permission);
  return { userId, roles: roles.length ? roles : ["funcionario"], perms };
}

// Resultado da política: filtros extras a aplicar, valores forçados no write,
// ou negação. Se ctx é null => service_role (sem restrição).
interface Policy {
  denied?: string;
  emptyResult?: boolean; // select que deve retornar vazio
  extraFilters?: QueryFilter[];
  forced?: Record<string, unknown>;
}

function policyFor(req: QueryReq, ctx: AccessCtx | null): Policy {
  if (!ctx) return {}; // service role
  const isAdmin = ctx.roles.includes("admin");
  const isRh = isAdmin || ctx.roles.includes("rh");
  const can = (p: string) => isAdmin || ctx.perms.includes(p);
  const own: QueryFilter = { col: "user_id", op: "eq", val: ctx.userId };
  const a = req.action;

  switch (req.table) {
    case "atestados":
      if (a === "select") return isRh ? {} : { extraFilters: [own] };
      if (a === "insert" || a === "upsert")
        return { forced: { user_id: ctx.userId } };
      if (a === "update")
        return can("approve_documents")
          ? {}
          : {
              extraFilters: [own, { col: "status", op: "eq", val: "pendente" }],
            };
      return { denied: "Operação não permitida" };

    case "audit_logs":
      if (a === "select") return isRh ? {} : { emptyResult: true };
      if (a === "insert") return { forced: { actor_id: ctx.userId } };
      return { denied: "Operação não permitida" };

    case "notifications":
      if (a === "select") return { extraFilters: [own] };
      if (a === "update") return { extraFilters: [own] };
      return { denied: "Operação não permitida" };

    case "profiles":
      if (a === "select")
        return isRh
          ? {}
          : { extraFilters: [{ col: "id", op: "eq", val: ctx.userId }] };
      if (a === "update")
        return can("manage_employees") || isAdmin
          ? {}
          : { extraFilters: [{ col: "id", op: "eq", val: ctx.userId }] };
      if (a === "insert" || a === "upsert")
        return isAdmin ? {} : { denied: "Apenas admin" };
      if (a === "delete") return isAdmin ? {} : { denied: "Apenas admin" };
      return {};

    case "user_roles":
      if (a === "select") return isRh ? {} : { extraFilters: [own] };
      return isAdmin ? {} : { denied: "Apenas admin" };

    case "rh_permissions":
      if (a === "select") return isAdmin ? {} : { extraFilters: [own] };
      return isAdmin ? {} : { denied: "Apenas admin" };

    case "employee_documents":
      if (a === "select") return isRh ? {} : { extraFilters: [own] };
      if (a === "insert" || a === "upsert")
        return { forced: { user_id: ctx.userId } };
      if (a === "update")
        return can("approve_documents")
          ? {}
          : {
              extraFilters: [own, { col: "status", op: "eq", val: "pendente" }],
            };
      if (a === "delete")
        return can("approve_documents")
          ? {}
          : {
              extraFilters: [own, { col: "status", op: "eq", val: "pendente" }],
            };
      return {};

    case "document_checklist":
      if (a === "select") return isRh ? {} : { extraFilters: [own] };
      if (a === "update") return isRh ? {} : { extraFilters: [own] };
      return isRh ? {} : { denied: "Apenas RH" };

    case "work_schedules":
      if (a === "select") return {};
      return can("configure_schedules")
        ? {}
        : { denied: "Sem permissão para escalas" };

    case "time_entries": {
      // Batida é registro probatório (O0-07): leitura ignora as excluídas;
      // o shim só cria a própria batida (self-punch). Edição/exclusão pelo RH
      // vai por src/lib/timesheet.functions.ts, com validação de ente e trilha.
      const notDeleted: QueryFilter = {
        col: "deleted_at",
        op: "is",
        val: null,
      };
      if (a === "select")
        return { extraFilters: isRh ? [notDeleted] : [own, notDeleted] };
      if (a === "insert") return { forced: { user_id: ctx.userId } };
      return {
        denied: "Edição e exclusão de ponto são feitas pelo módulo de ponto",
      };
    }

    case "unidades":
      if (a === "select") return isRh ? {} : { emptyResult: true };
      return can("manage_employees")
        ? {}
        : { denied: "Sem permissão para unidades" };

    default:
      return { denied: "Tabela não permitida" };
  }
}

interface SqlBuild {
  text: string;
  params: unknown[];
}

function pushParam(params: unknown[], val: unknown): string {
  params.push(val);
  return `$${params.length}`;
}

function filterPredicates(
  filters: QueryFilter[],
  params: unknown[],
  alias = "t",
): string[] {
  return filters.map((f) => {
    const col = `${alias}.${ident(f.col)}`;
    if (f.op === "in") {
      const arr = Array.isArray(f.val) ? f.val : [f.val];
      if (arr.length === 0) return "false";
      const ph = arr.map((v) => pushParam(params, v)).join(", ");
      return `${col} IN (${ph})`;
    }
    if (f.op === "is") {
      if (f.val === null) return `${col} IS NULL`;
      return `${col} IS ${pushParam(params, f.val)}`;
    }
    const opMap: Record<string, string> = {
      eq: "=",
      neq: "<>",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
    };
    return `${col} ${opMap[f.op]} ${pushParam(params, f.val)}`;
  });
}

// Predicado que restringe a tabela ao tenant validado. A coluna vem do registro
// (autoria do servidor, cercada por ident); o tenant vai por pushParam. Sem
// concatenação de dado do cliente, sem risco de injeção.
function tenantPredicate(
  scope: { column: string; kind: "direct" | "member" },
  tenantId: string,
  params: unknown[],
  alias = "t",
): string {
  const col = `${alias}.${ident(scope.column)}`;
  if (scope.kind === "direct") {
    return `${col} = ${pushParam(params, tenantId)}`;
  }
  // via_member: só linhas de usuários com associação ativa ao ente.
  return `${col} IN (SELECT user_id FROM public.tenant_memberships WHERE tenant_id = ${pushParam(
    params,
    tenantId,
  )} AND status = 'ativo')`;
}

// Monta a cláusula WHERE a partir dos predicados de filtro e, opcionalmente, do
// predicado de tenant, combinados por AND.
function composeWhere(
  filters: QueryFilter[],
  scope: { column: string; kind: "direct" | "member" } | null,
  tenantId: string | null,
  params: unknown[],
  alias = "t",
): string {
  const parts = filterPredicates(filters, params, alias);
  if (scope && tenantId) {
    parts.push(tenantPredicate(scope, tenantId, params, alias));
  }
  return parts.length ? "WHERE " + parts.join(" AND ") : "";
}

function buildSelectColumns(
  table: string,
  columns: string | undefined,
  params: unknown[],
): { sel: string; join: string } {
  const cols = (columns ?? "*").trim();
  const tokens = splitTopLevel(cols);
  const plain: string[] = [];
  const joins: string[] = [];
  let embedIdx = 0;
  for (const tokRaw of tokens) {
    const tok = tokRaw.trim();
    const m = tok.match(/^([a-z_][a-z0-9_]*)\s*\(\s*\*\s*\)$/);
    if (m) {
      const embedName = m[1];
      const fk = EMBEDS[table]?.[embedName];
      if (!fk) throw new Error(`Embed não suportado: ${embedName}`);
      const alias = `e${embedIdx++}`;
      joins.push(
        `LEFT JOIN ${ident(fk.refTable)} ${alias} ON ${alias}."id" = t.${ident(fk.localCol)}`,
      );
      plain.push(
        `CASE WHEN ${alias}."id" IS NULL THEN NULL ELSE to_jsonb(${alias}.*) END AS ${ident(embedName)}`,
      );
    } else if (tok === "*") {
      plain.push("t.*");
    } else {
      plain.push(`t.${ident(tok)}`);
    }
  }
  return {
    sel: plain.join(", "),
    join: joins.length ? " " + joins.join(" ") : "",
  };
}

// separa por vírgula no nível superior (ignora vírgulas dentro de parênteses)
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function mergeForced(
  values: Record<string, unknown> | Record<string, unknown>[] | undefined,
  forced: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const arr = Array.isArray(values) ? values : values ? [values] : [];
  if (!forced) return arr;
  return arr.map((v) => ({ ...v, ...forced }));
}

export async function runQuery(
  req: QueryReq,
  ctx: AccessCtx | null,
  tenantId: string | null = null,
): Promise<QueryResult> {
  try {
    const strat = tableStrategy(req.table);
    if (!strat) {
      return { data: null, error: { message: "Tabela não permitida" } };
    }
    const pol = policyFor(req, ctx);
    if (pol.denied) return { data: null, error: { message: pol.denied } };
    if (pol.emptyResult) return { data: [], error: null };

    const filters: QueryFilter[] = [
      ...(req.filters ?? []),
      ...(pol.extraFilters ?? []),
    ];
    let forcedWrite = pol.forced;
    const table = ident(req.table);
    const params: unknown[] = [];

    // ---- Escopo de tenant ----
    // `scope` != null => o WHERE ganha o predicado de tenant (composeWhere).
    // ctx === null é service-role interno (sem shim) e passa sem escopo, como já
    // faz policyFor. Sem tenant ativo, fecha-se o alargamento de RH/admin: uma
    // tabela via_member cai para as próprias linhas do usuário; uma tabela direct
    // (unidades) não tem coluna de usuário, logo nada a mostrar sem tenant.
    let scope: { column: string; kind: "direct" | "member" } | null = null;
    if (ctx && strat.strategy !== "global") {
      if (tenantId) {
        scope = {
          column: strat.column,
          kind: strat.strategy === "direct" ? "direct" : "member",
        };
        if (
          strat.strategy === "direct" &&
          (req.action === "insert" || req.action === "upsert")
        ) {
          forcedWrite = { ...(forcedWrite ?? {}), [strat.column]: tenantId };
        }
      } else if (strat.strategy === "direct") {
        if (req.action === "select")
          return { data: req.single ? null : [], error: null };
        return { data: null, error: { message: "Sem entidade ativa" } };
      } else if (req.action === "select") {
        // via_member sem tenant: leitura cai para as próprias linhas do usuário.
        // Só em SELECT — em UPDATE/DELETE a trava de "sem filtro" abaixo
        // continua valendo, para não transformar uma escrita sem .eq() numa
        // atualização em massa silenciosa.
        filters.push({ col: strat.column, op: "eq", val: ctx.userId });
      }
    }

    if (req.action === "select") {
      const { sel, join } = buildSelectColumns(req.table, req.columns, params);
      let text = `SELECT ${sel} FROM ${table} t${join} ${composeWhere(filters, scope, tenantId, params)}`;
      if (req.order?.length) {
        const ob = req.order
          .map((o) => `t.${ident(o.col)} ${o.ascending ? "ASC" : "DESC"}`)
          .join(", ");
        text += ` ORDER BY ${ob}`;
      }
      if (req.single || req.maybeSingle) text += " LIMIT 1";
      else if (typeof req.limit === "number")
        text += ` LIMIT ${Math.max(0, Math.floor(req.limit))}`;
      const rows = await query(text, params);
      if (req.single) {
        if (rows.length === 0)
          return { data: null, error: { message: "No rows found" } };
        return { data: rows[0], error: null };
      }
      if (req.maybeSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    if (req.action === "insert" || req.action === "upsert") {
      const rowsIn = mergeForced(req.values, forcedWrite);
      if (rowsIn.length === 0)
        return { data: null, error: { message: "Nada a inserir" } };
      const colsSet = new Set<string>();
      rowsIn.forEach((r) => Object.keys(r).forEach((k) => colsSet.add(k)));
      const cols = [...colsSet];
      const colSql = cols.map((c) => ident(c)).join(", ");
      const valuesSql = rowsIn
        .map(
          (r) =>
            "(" +
            cols.map((c) => pushParam(params, r[c] ?? null)).join(", ") +
            ")",
        )
        .join(", ");
      let text = `INSERT INTO ${table} (${colSql}) VALUES ${valuesSql}`;
      if (req.action === "upsert") {
        const conflictCols = (req.onConflict ?? "id")
          .split(",")
          .map((c) => ident(c))
          .join(", ");
        if (req.ignoreDuplicates) {
          text += ` ON CONFLICT (${conflictCols}) DO NOTHING`;
        } else {
          const upd = cols
            .filter(
              (c) =>
                !(req.onConflict ?? "id")
                  .split(",")
                  .map((x) => x.trim())
                  .includes(c),
            )
            .map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`)
            .join(", ");
          text += ` ON CONFLICT (${conflictCols}) DO ${upd ? `UPDATE SET ${upd}` : "NOTHING"}`;
        }
      }
      if (req.wantReturning || req.single) text += " RETURNING *";
      const rows = await query(text, params);
      if (req.single) return { data: rows[0] ?? null, error: null };
      if (req.wantReturning) return { data: rows, error: null };
      return { data: null, error: null };
    }

    if (req.action === "update") {
      const vals =
        (Array.isArray(req.values) ? req.values[0] : req.values) ?? {};
      const merged = { ...vals, ...(forcedWrite ?? {}) };
      const setCols = Object.keys(merged);
      if (setCols.length === 0)
        return { data: null, error: { message: "Nada a atualizar" } };
      // Simétrico à trava do DELETE abaixo. Sem esta verificação, uma chamada
      // sem .eq() vira `UPDATE tabela SET ...` sem WHERE e reescreve todas as
      // linhas — inclusive as de outros entes, já que este caminho não tem
      // noção de tenant. É destruição de dados em massa, não vazamento.
      if (filters.length === 0)
        return {
          data: null,
          error: { message: "UPDATE sem filtro bloqueado" },
        };
      const setSql = setCols
        .map((c) => `${ident(c)} = ${pushParam(params, merged[c] ?? null)}`)
        .join(", ");
      let text = `UPDATE ${table} t SET ${setSql} ${composeWhere(filters, scope, tenantId, params)}`;
      if (req.wantReturning || req.single) text += " RETURNING *";
      const rows = await query(text, params);
      if (req.single) return { data: rows[0] ?? null, error: null };
      if (req.wantReturning) return { data: rows, error: null };
      return { data: null, error: null };
    }

    if (req.action === "delete") {
      if (filters.length === 0)
        return {
          data: null,
          error: { message: "DELETE sem filtro bloqueado" },
        };
      const text = `DELETE FROM ${table} t ${composeWhere(filters, scope, tenantId, params)}`;
      await query(text, params);
      return { data: null, error: null };
    }

    return { data: null, error: { message: "Ação desconhecida" } };
  } catch (e) {
    // A mensagem crua do PostgreSQL revela nomes de tabela, de coluna e
    // estrutura de constraint ao navegador. Fica no log do servidor; o cliente
    // recebe apenas a indicação de falha.
    console.error("[pgrest] falha na consulta", {
      table: req.table,
      action: req.action,
      error: e instanceof Error ? e.message : e,
    });
    return { data: null, error: { message: "Erro na consulta" } };
  }
}

export { queryOne };
