/**
 * Sprint 18 — IA analítica: teste de COMPORTAMENTO (substitui validate-sprint18).
 *
 * A defesa central é: o usuário NÃO escreve SQL — a pergunta em linguagem natural
 * é resolvida para uma métrica de uma whitelist fechada. Este teste executa o
 * `resolveSemanticIntent` real (empacotado, com os deps de servidor stubados) e
 * afere o mapeamento e o `null` para o que está fora da whitelist. Redes de
 * conformidade (lint): sem SQL livre da pergunta; PGlite: a tabela de painéis existe.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createTestDb } from "./helpers/pglite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "ia-test-"));

// Stubs dos deps de servidor: só interessa a função pura resolveSemanticIntent.
const startStub = join(dir, "start.mjs");
writeFileSync(
  startStub,
  `export function createServerFn() {
     const b = {}; for (const m of ["middleware","validator","inputValidator","handler"]) b[m] = () => b; return b;
   }`,
);
const dbStub = join(dir, "db.mjs");
writeFileSync(dbStub, `export async function query() { return []; }`);
const dataStub = join(dir, "data.mjs");
writeFileSync(dataStub, `export const requireAuth = {};`);
const taStub = join(dir, "ta.mjs");
writeFileSync(
  taStub,
  `export async function loadTenantAccess() { return {}; }
   export function requireTenantPermission() {}`,
);

const bundle = join(dir, "ai.mjs");
await build({
  entryPoints: ["src/lib/ai-analytics.functions.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundle,
  logLevel: "silent",
  external: ["node:*"],
  plugins: [
    {
      name: "stub",
      setup(b) {
        b.onResolve({ filter: /@tanstack\/react-start$/ }, () => ({
          path: startStub,
          external: true,
        }));
        b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({
          path: dbStub,
          external: true,
        }));
        b.onResolve({ filter: /(^|\/)data\.functions$/ }, () => ({
          path: dataStub,
          external: true,
        }));
        b.onResolve({ filter: /(^|\/)tenant-access\.server$/ }, () => ({
          path: taStub,
          external: true,
        }));
      },
    },
  ],
});
const { resolveSemanticIntent } = await import(bundle);

let db;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("runtime: a pergunta resolve para métrica da whitelist", () => {
  assert.equal(
    resolveSemanticIntent("quantos servidores ativos?"),
    "headcount",
  );
  assert.equal(
    resolveSemanticIntent("qual a folha líquida do mês"),
    "net_payroll",
  );
  assert.equal(resolveSemanticIntent("valor bruto da folha"), "gross_payroll");
  assert.equal(resolveSemanticIntent("total de descontos"), "deductions");
  assert.equal(
    resolveSemanticIntent("estamos dentro do limite da LRF?"),
    "lrf_ratio",
  );
});

test("runtime: pergunta fora da whitelist devolve null (sem SQL livre possível)", () => {
  assert.equal(resolveSemanticIntent("apague a tabela de usuários"), null);
  assert.equal(resolveSemanticIntent("select * from app_users"), null);
});

test("lint: não existe SQL livre a partir da pergunta", () => {
  const src = readFileSync(
    join(root, "src", "lib", "ai-analytics.functions.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    src,
    /query<any>\(data\.question/,
    "a pergunta do usuário nunca vira SQL",
  );
  assert.match(src, /limit 12/, "as consultas são limitadas");
});

test("schema: a tabela de painéis salvos existe", async () => {
  const r = await db.query(
    `select 1 from information_schema.tables
     where table_schema='public' and table_name='ai_saved_panels'`,
  );
  assert.equal(r.rows.length, 1);
});
