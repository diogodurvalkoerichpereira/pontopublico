// Compilador de QueryReq -> SQL parametrizado, com autorização por linha
// portada das RLS originais do Supabase. SOMENTE servidor.
import { query, queryOne } from "./db.server";
import type { QueryReq, QueryFilter, QueryResult } from "./pgrest-types";

const ALLOWED_TABLES = new Set([
  "profiles",
  "user_roles",
  "rh_permissions",
  "atestados",
  "audit_logs",
  "notifications",
  "employee_documents",
  "document_checklist",
  "work_schedules",
  "time_entries",
  "payroll_periods",
  "payroll_config",
  "unidades",
]);

// Relações to-one suportadas em select embutido (ex: "*, work_schedules(*)").
const EMBEDS: Record<string, Record<string, { localCol: string; refTable: string }>> = {
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
      if (a === "insert" || a === "upsert") return { forced: { user_id: ctx.userId } };
      if (a === "update")
        return can("approve_documents")
          ? {}
          : { extraFilters: [own, { col: "status", op: "eq", val: "pendente" }] };
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
      if (a === "select") return isRh ? {} : { extraFilters: [{ col: "id", op: "eq", val: ctx.userId }] };
      if (a === "update")
        return can("manage_employees") || isAdmin
          ? {}
          : { extraFilters: [{ col: "id", op: "eq", val: ctx.userId }] };
      if (a === "insert" || a === "upsert") return isAdmin ? {} : { denied: "Apenas admin" };
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
      if (a === "insert" || a === "upsert") return { forced: { user_id: ctx.userId } };
      if (a === "update")
        return can("approve_documents")
          ? {}
          : { extraFilters: [own, { col: "status", op: "eq", val: "pendente" }] };
      if (a === "delete")
        return can("approve_documents") ? {} : { extraFilters: [own, { col: "status", op: "eq", val: "pendente" }] };
      return {};

    case "document_checklist":
      if (a === "select") return isRh ? {} : { extraFilters: [own] };
      if (a === "update") return isRh ? {} : { extraFilters: [own] };
      return isRh ? {} : { denied: "Apenas RH" };

    case "work_schedules":
      if (a === "select") return {};
      return can("configure_schedules") ? {} : { denied: "Sem permissão para escalas" };

    case "time_entries":
      if (a === "select") return isRh ? {} : { extraFilters: [own] };
      if (a === "insert")
        return can("manage_employees") ? {} : { forced: { user_id: ctx.userId } };
      return can("manage_employees") ? {} : { denied: "Sem permissão" };

    case "payroll_periods":
      if (a === "select") return isRh ? {} : { extraFilters: [own] };
      return can("close_payroll") ? {} : { denied: "Sem permissão para folha" };

    case "payroll_config":
      if (a === "select") return {};
      return can("close_payroll") ? {} : { denied: "Sem permissão para folha" };

    case "unidades":
      if (a === "select") return isRh ? {} : { emptyResult: true };
      return can("manage_employees") ? {} : { denied: "Sem permissão para unidades" };

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

function whereClause(filters: QueryFilter[], params: unknown[], alias = "t"): string {
  if (!filters.length) return "";
  const parts = filters.map((f) => {
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
  return "WHERE " + parts.join(" AND ");
}

function buildSelectColumns(table: string, columns: string | undefined, params: unknown[]): { sel: string; join: string } {
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
  return { sel: plain.join(", "), join: joins.length ? " " + joins.join(" ") : "" };
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

export async function runQuery(req: QueryReq, ctx: AccessCtx | null): Promise<QueryResult> {
  try {
    if (!ALLOWED_TABLES.has(req.table)) {
      return { data: null, error: { message: "Tabela não permitida" } };
    }
    const pol = policyFor(req, ctx);
    if (pol.denied) return { data: null, error: { message: pol.denied } };
    if (pol.emptyResult) return { data: [], error: null };

    const filters: QueryFilter[] = [...(req.filters ?? []), ...(pol.extraFilters ?? [])];
    const table = ident(req.table);
    const params: unknown[] = [];

    if (req.action === "select") {
      const { sel, join } = buildSelectColumns(req.table, req.columns, params);
      let text = `SELECT ${sel} FROM ${table} t${join} ${whereClause(filters, params)}`;
      if (req.order?.length) {
        const ob = req.order
          .map((o) => `t.${ident(o.col)} ${o.ascending ? "ASC" : "DESC"}`)
          .join(", ");
        text += ` ORDER BY ${ob}`;
      }
      if (req.single || req.maybeSingle) text += " LIMIT 1";
      else if (typeof req.limit === "number") text += ` LIMIT ${Math.max(0, Math.floor(req.limit))}`;
      const rows = await query(text, params);
      if (req.single) {
        if (rows.length === 0) return { data: null, error: { message: "No rows found" } };
        return { data: rows[0], error: null };
      }
      if (req.maybeSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    if (req.action === "insert" || req.action === "upsert") {
      const rowsIn = mergeForced(req.values, pol.forced);
      if (rowsIn.length === 0) return { data: null, error: { message: "Nada a inserir" } };
      const colsSet = new Set<string>();
      rowsIn.forEach((r) => Object.keys(r).forEach((k) => colsSet.add(k)));
      const cols = [...colsSet];
      const colSql = cols.map((c) => ident(c)).join(", ");
      const valuesSql = rowsIn
        .map(
          (r) =>
            "(" + cols.map((c) => pushParam(params, r[c] ?? null)).join(", ") + ")",
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
            .filter((c) => !(req.onConflict ?? "id").split(",").map((x) => x.trim()).includes(c))
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
      const vals = (Array.isArray(req.values) ? req.values[0] : req.values) ?? {};
      const merged = { ...vals, ...(pol.forced ?? {}) };
      const setCols = Object.keys(merged);
      if (setCols.length === 0) return { data: null, error: { message: "Nada a atualizar" } };
      const setSql = setCols.map((c) => `${ident(c)} = ${pushParam(params, merged[c] ?? null)}`).join(", ");
      let text = `UPDATE ${table} t SET ${setSql} ${whereClause(filters, params)}`;
      if (req.wantReturning || req.single) text += " RETURNING *";
      const rows = await query(text, params);
      if (req.single) return { data: rows[0] ?? null, error: null };
      if (req.wantReturning) return { data: rows, error: null };
      return { data: null, error: null };
    }

    if (req.action === "delete") {
      if (filters.length === 0) return { data: null, error: { message: "DELETE sem filtro bloqueado" } };
      const text = `DELETE FROM ${table} t ${whereClause(filters, params)}`;
      await query(text, params);
      return { data: null, error: null };
    }

    return { data: null, error: { message: "Ação desconhecida" } };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erro na consulta";
    return { data: null, error: { message } };
  }
}

export { queryOne };
