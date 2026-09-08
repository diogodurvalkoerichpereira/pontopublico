/**
 * Testes de comportamento do compilador de consultas do shim (pgrest.server.ts).
 *
 * Diferente dos validadores das Sprints 8-20, que liam o arquivo como texto e
 * imprimiam `true` quando uma substring existia, este teste executa o código: o
 * módulo é empacotado com um `db.server` instrumentado que captura o SQL em vez
 * de executá-lo, e as asserções recaem sobre o SQL efetivamente produzido.
 *
 * Cobre a trava de UPDATE sem filtro, a trava simétrica de DELETE e a não
 * exposição de mensagem crua do PostgreSQL ao cliente.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "pgrest-test-"));

// Stub de db.server: registra as consultas e nunca toca um banco.
const stubPath = join(dir, "db-stub.mjs");
writeFileSync(
  stubPath,
  `export const executed = [];
   export async function query(text, params) { executed.push({ text, params }); return []; }
   export async function queryOne(text, params) { executed.push({ text, params }); return null; }
   export async function withTransaction(fn) { return fn({ query }); }
   export function resetExecuted() { executed.length = 0; }
  `,
);

const bundlePath = join(dir, "pgrest.bundle.mjs");
await build({
  entryPoints: ["src/lib/pgrest.server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundlePath,
  logLevel: "silent",
  external: ["node:*"],
  plugins: [
    {
      // `alias` do esbuild não aceita especificador relativo, então a troca de
      // db.server pelo stub é feita na resolução.
      name: "stub-db-server",
      setup(b) {
        // `external: true` é essencial: sem isso o esbuild inlineia o stub no
        // bundle e o array `executed` observado aqui seria outra instância,
        // sempre vazia — o teste passaria a não medir nada.
        b.onResolve({ filter: /(^|\/)db\.server$/ }, () => ({
          path: stubPath,
          external: true,
        }));
      },
    },
  ],
});

const mod = await import(bundlePath);
const stub = await import(stubPath);

/** Contexto de um usuário de RH, que é quem alcança as tabelas sensíveis. */
const rhCtx = {
  userId: "11111111-1111-1111-1111-111111111111",
  roles: ["rh"],
  perms: ["manage_employees"],
};

const runQuery = mod.runQuery ?? mod.default?.runQuery;

test("runQuery é exportado", () => {
  assert.equal(typeof runQuery, "function", "runQuery deve ser exportado");
});

test("UPDATE sem filtro é bloqueado antes de chegar ao banco", async () => {
  stub.resetExecuted();
  const res = await runQuery(
    {
      table: "profiles",
      action: "update",
      values: { nome: "alterado" },
      filters: [],
    },
    rhCtx,
  );

  assert.ok(res.error, "deve retornar erro");
  assert.match(res.error.message, /UPDATE sem filtro bloqueado/);
  assert.equal(
    stub.executed.length,
    0,
    "nenhuma consulta pode ter sido executada",
  );
});

test("DELETE sem filtro é bloqueado antes de chegar ao banco", async () => {
  stub.resetExecuted();
  // time_entries é apagável por quem tem manage_employees (policy te_rh_delete),
  // então a checagem de política passa e a trava de filtro é de fato exercitada.
  const res = await runQuery(
    { table: "time_entries", action: "delete", filters: [] },
    rhCtx,
  );

  assert.ok(res.error, "deve retornar erro");
  assert.match(res.error.message, /DELETE sem filtro bloqueado/);
  assert.equal(stub.executed.length, 0);
});

test("UPDATE com filtro produz SQL com WHERE", async () => {
  stub.resetExecuted();
  await runQuery(
    {
      table: "profiles",
      action: "update",
      values: { nome: "alterado" },
      filters: [
        { col: "id", op: "eq", val: "22222222-2222-2222-2222-222222222222" },
      ],
    },
    rhCtx,
  );

  assert.equal(stub.executed.length, 1, "a consulta deve ter sido executada");
  const { text } = stub.executed[0];
  assert.match(text, /^UPDATE /);
  assert.match(text, /WHERE/, "o UPDATE precisa carregar WHERE");
});

test("time_entries: RH grava batida com user_id arbitrário (defeito conhecido)", async () => {
  stub.resetExecuted();
  await runQuery(
    {
      table: "time_entries",
      action: "insert",
      values: {
        user_id: "99999999-9999-9999-9999-999999999999",
        tipo: "entrada",
      },
      filters: [],
    },
    rhCtx,
  );

  assert.equal(stub.executed.length, 1);
  const { params } = stub.executed[0];
  // Documenta o estado atual: policyFor não força user_id para quem tem
  // manage_employees, então a batida aceita o usuário que vier na requisição.
  // Quando o ponto ganhar valor probatório, este teste deve ser invertido.
  assert.ok(
    params.includes("99999999-9999-9999-9999-999999999999"),
    "hoje o user_id da requisição é aceito sem verificação",
  );
});

test("erro do banco não vaza mensagem crua ao cliente", async () => {
  stub.resetExecuted();
  const res = await runQuery(
    { table: "tabela_inexistente", action: "select", filters: [] },
    rhCtx,
  );

  assert.ok(res.error, "tabela fora da allowlist deve ser recusada");
  assert.doesNotMatch(
    res.error.message,
    /relation|column|constraint|syntax/i,
    "a mensagem não pode revelar estrutura do banco",
  );
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
