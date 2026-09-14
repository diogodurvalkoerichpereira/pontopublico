// Camada de acesso ao PostgreSQL (attestado-db) — substitui o backend Supabase.
// SOMENTE servidor. Nunca importar em código de cliente.
import { Pool } from "pg";
import { traduzirErroDoBanco } from "./db-errors.server";

let _pool: Pool | undefined;

export function getPool(): Pool {
  if (!_pool) {
    const connectionString =
      process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL não configurada");
    }
    _pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return _pool;
}

// Toda consulta passa por aqui, então é aqui que a violação de constraint vira
// frase legível: um `check` disparado mostrava ao usuário o nome da tabela e da
// constraint, em inglês. O erro original vai no `cause`, para o log do servidor.
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    const res = await getPool().query(text, params as never[]);
    return res.rows as T[];
  } catch (e) {
    throw traduzirErroDoBanco(e);
  }
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    // Dentro da transação o handler usa `client.query` direto, que não passa
    // pelo `query` acima — a tradução tem de acontecer também aqui.
    throw traduzirErroDoBanco(e);
  } finally {
    client.release();
  }
}
