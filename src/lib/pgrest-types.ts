// Tipos compartilhados entre o shim (cliente) e o compilador de query (servidor).
// Não importar nada de servidor aqui (é usado no bundle do cliente).

export type FilterOp = "eq" | "neq" | "in" | "gt" | "gte" | "lt" | "lte" | "is";

export interface QueryFilter {
  col: string;
  op: FilterOp;
  val: unknown;
}

export interface QueryOrder {
  col: string;
  ascending: boolean;
}

export type QueryAction = "select" | "insert" | "update" | "delete" | "upsert";

export interface QueryReq {
  table: string;
  action: QueryAction;
  // Tenant ativo, anexado pelo shim a partir de localStorage. Opcional porque há
  // fluxos legítimos sem tenant (login, bootstrap do contexto). O servidor
  // valida contra tenant_memberships antes de confiar — nunca é usado cru.
  tenant_id?: string;
  columns?: string;
  values?: Record<string, unknown> | Record<string, unknown>[];
  filters?: QueryFilter[];
  order?: QueryOrder[];
  limit?: number;
  single?: boolean;
  maybeSingle?: boolean;
  wantReturning?: boolean;
  onConflict?: string;
  ignoreDuplicates?: boolean;
}

export interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}
