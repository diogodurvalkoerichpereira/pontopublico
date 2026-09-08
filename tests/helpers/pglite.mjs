// Helper de teste: sobe o esquema real (bootstrap + migrations) num PostgreSQL 17
// em memória via PGlite, para que os testes afiram COMPORTAMENTO (SQL executado),
// não texto de arquivo. É a fonte única da lista/ordem de arquivos — o gate
// `scripts/db-dryrun.mjs` importa `migrationFiles()` daqui para não divergir.
//
// NÃO é um arquivo `*.test.mjs`, então `node --test "tests/**/*.test.mjs"` não o
// coleta como teste — é só um utilitário importável.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Este helper está em tests/helpers/, dois níveis abaixo da raiz do repo.
const ROOT = resolve(import.meta.dirname, "..", "..");

// Ordem de aplicação: o compat do Supabase (roles, auth.uid(), schemas, storage,
// publication) antes das migrations propriamente ditas.
const DIRS = [
  join(ROOT, "db", "bootstrap"),
  join(ROOT, "supabase", "migrations"),
];

/** Caminhos dos .sql na ordem de aplicação (lexicográfica = ordem de timestamp). */
export function migrationFiles() {
  const files = [];
  for (const dir of DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      files.push(join(dir, f));
    }
  }
  return files;
}

/**
 * Sobe uma PGlite nova e aplica todo o esquema, um arquivo por `exec` (nunca uma
 * transação única: há arquivos com `begin;`/`commit;` próprios e um
 * `ALTER TYPE … ADD VALUE` que exige transações separadas). Falha no primeiro
 * erro, com o nome do arquivo — diferente do db-dryrun, que coleta todas as
 * falhas. Devolve o handle da PGlite; o teste deve chamar `db.close()` no fim.
 */
export async function createTestDb() {
  const db = new PGlite();
  for (const path of migrationFiles()) {
    try {
      await db.exec(readFileSync(path, "utf8"));
    } catch (e) {
      const nome = path.slice(ROOT.length + 1);
      const msg = String(e?.message ?? e).split("\n")[0];
      throw new Error(`Falha ao aplicar ${nome}: ${msg}`);
    }
  }
  return db;
}
