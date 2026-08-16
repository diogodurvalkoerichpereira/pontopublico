// Shim compatível com o subconjunto de supabase-js usado pelo app,
// mas apoiado no backend próprio (PostgreSQL via server functions).
import {
  dbQuery,
  signIn as signInFn,
  signUp as signUpFn,
  storageUpload,
  storageDownload,
  signOutSession,
} from "@/lib/data.functions";
import type { QueryReq, QueryFilter } from "@/lib/pgrest-types";

const SESSION_KEY = "attestado.session";

export interface AppSession {
  access_token: string;
  token_type: string;
  user: { id: string; email: string; user_metadata: Record<string, unknown> };
}

type AuthEvent = "SIGNED_IN" | "SIGNED_OUT" | "INITIAL_SESSION";
type AuthListener = (event: AuthEvent, session: AppSession | null) => void;

let currentSession: AppSession | null | undefined;
const listeners = new Set<AuthListener>();

function readStored(): AppSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as AppSession) : null;
  } catch {
    return null;
  }
}

function getSessionSync(): AppSession | null {
  if (currentSession === undefined) currentSession = readStored();
  return currentSession;
}

function setSession(s: AppSession | null) {
  currentSession = s;
  if (typeof window !== "undefined") {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  }
  const evt: AuthEvent = s ? "SIGNED_IN" : "SIGNED_OUT";
  listeners.forEach((l) => l(evt, s));
}

// ---------------- Query builder ----------------
class QueryBuilder implements PromiseLike<{
  data: unknown;
  error: { message: string } | null;
}> {
  private req: QueryReq;
  constructor(table: string) {
    this.req = { table, action: "select", filters: [] };
  }
  select(columns?: string) {
    if (this.req.action === "select") {
      this.req.columns = columns ?? "*";
    } else {
      this.req.wantReturning = true;
    }
    return this;
  }
  insert(values: Record<string, unknown> | Record<string, unknown>[]) {
    this.req.action = "insert";
    this.req.values = values;
    return this;
  }
  update(values: Record<string, unknown>) {
    this.req.action = "update";
    this.req.values = values;
    return this;
  }
  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) {
    this.req.action = "upsert";
    this.req.values = values;
    if (opts?.onConflict) this.req.onConflict = opts.onConflict;
    if (opts?.ignoreDuplicates) this.req.ignoreDuplicates = true;
    return this;
  }
  delete() {
    this.req.action = "delete";
    return this;
  }
  private addFilter(f: QueryFilter) {
    (this.req.filters ??= []).push(f);
    return this;
  }
  eq(col: string, val: unknown) {
    return this.addFilter({ col, op: "eq", val });
  }
  neq(col: string, val: unknown) {
    return this.addFilter({ col, op: "neq", val });
  }
  in(col: string, val: unknown[]) {
    return this.addFilter({ col, op: "in", val });
  }
  gt(col: string, val: unknown) {
    return this.addFilter({ col, op: "gt", val });
  }
  gte(col: string, val: unknown) {
    return this.addFilter({ col, op: "gte", val });
  }
  lt(col: string, val: unknown) {
    return this.addFilter({ col, op: "lt", val });
  }
  lte(col: string, val: unknown) {
    return this.addFilter({ col, op: "lte", val });
  }
  is(col: string, val: unknown) {
    return this.addFilter({ col, op: "is", val });
  }
  order(col: string, opts?: { ascending?: boolean }) {
    (this.req.order ??= []).push({ col, ascending: opts?.ascending ?? true });
    return this;
  }
  limit(n: number) {
    this.req.limit = n;
    return this;
  }
  single() {
    this.req.single = true;
    return this;
  }
  maybeSingle() {
    this.req.maybeSingle = true;
    return this;
  }
  private async exec() {
    try {
      return await dbQuery({ data: this.req });
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : "Erro" },
      };
    }
  }
  then<
    TResult1 = { data: unknown; error: { message: string } | null },
    TResult2 = never,
  >(
    onfulfilled?:
      | ((value: {
          data: unknown;
          error: { message: string } | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

// ---------------- Storage ----------------
function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function storageBucket(bucket: string) {
  return {
    async upload(
      path: string,
      file: Blob,
      opts?: { contentType?: string; upsert?: boolean },
    ) {
      try {
        const base64 = await fileToBase64(file);
        const res = await storageUpload({
          data: { bucket, path, base64, contentType: opts?.contentType },
        });
        if (res.error) return { data: null, error: { message: res.error } };
        return { data: { path }, error: null };
      } catch (e) {
        return {
          data: null,
          error: {
            message: e instanceof Error ? e.message : "Falha no upload",
          },
        };
      }
    },
    async createSignedUrl(path: string, _expiresIn: number) {
      try {
        const res = await storageDownload({ data: { bucket, path } });
        if (res.error || !res.base64)
          return { data: null, error: { message: res.error ?? "Erro" } };
        const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: guessMime(path) });
        const signedUrl = URL.createObjectURL(blob);
        return { data: { signedUrl }, error: null };
      } catch (e) {
        return {
          data: null,
          error: { message: e instanceof Error ? e.message : "Erro" },
        };
      }
    },
  };
}

// ---------------- Realtime (stub por polling) ----------------
function makeChannel(_name: string) {
  let interval: ReturnType<typeof setInterval> | undefined;
  const channel = {
    on(_event: string, _filter: unknown, cb: () => void) {
      // Polling leve para aproximar o comportamento de tempo real.
      interval = setInterval(() => cb(), 20_000);
      return channel;
    },
    subscribe() {
      return channel;
    },
    _teardown() {
      if (interval) clearInterval(interval);
    },
  };
  return channel;
}

// ---------------- Objeto supabase ----------------
export const supabase = {
  auth: {
    async getSession() {
      return { data: { session: getSessionSync() }, error: null };
    },
    async getUser() {
      const s = getSessionSync();
      return { data: { user: s?.user ?? null }, error: null };
    },
    onAuthStateChange(cb: AuthListener) {
      listeners.add(cb);
      // dispara sessão inicial (assíncrono como o supabase-js)
      setTimeout(() => cb("INITIAL_SESSION", getSessionSync()), 0);
      return {
        data: {
          subscription: {
            unsubscribe() {
              listeners.delete(cb);
            },
          },
        },
      };
    },
    async signUp(args: {
      email: string;
      password: string;
      options?: { data?: Record<string, unknown> };
    }) {
      const meta = args.options?.data ?? {};
      const res = await signUpFn({
        data: {
          email: args.email,
          password: args.password,
          full_name: (meta.full_name as string) ?? "",
          matricula: (meta.matricula as string) ?? "",
          cpf: (meta.cpf as string) ?? "",
          setor: (meta.setor as string) ?? "",
        },
      });
      if (res.error)
        return {
          data: { session: null, user: null },
          error: { message: res.error },
        };
      setSession(res.session!);
      return {
        data: { session: res.session, user: res.session!.user },
        error: null,
      };
    },
    async signInWithPassword(args: { email: string; password: string }) {
      const res = await signInFn({
        data: { email: args.email, password: args.password },
      });
      if (res.error)
        return {
          data: { session: null, user: null },
          error: { message: res.error },
        };
      setSession(res.session!);
      return {
        data: { session: res.session, user: res.session!.user },
        error: null,
      };
    },
    async signOut() {
      if (getSessionSync()) {
        try {
          await signOutSession();
        } catch {
          // A sessão local ainda deve ser removida se já tiver expirado no servidor.
        }
      }
      setSession(null);
      return { error: null };
    },
  },
  from(table: string) {
    return new QueryBuilder(table);
  },
  storage: {
    from(bucket: string) {
      return storageBucket(bucket);
    },
  },
  channel(name: string) {
    return makeChannel(name);
  },
  removeChannel(channel: { _teardown?: () => void }) {
    channel?._teardown?.();
  },
};
