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
  // employee_documents é apagável por quem tem approve_documents, então a
  // política passa e a trava de "sem filtro" é de fato exercitada. (time_entries
  // não serve mais: seu delete é negado antes, pelo O0-07.)
  const res = await runQuery(
    { table: "employee_documents", action: "delete", filters: [] },
    { userId: rhCtx.userId, roles: ["rh"], perms: ["approve_documents"] },
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

// ---------------------------------------------------------------------------
// Isolamento de tenant (O0-06). runQuery(req, ctx, tenantId).
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

test("direct/unidades com tenant: WHERE filtra por tenant_id", async () => {
  stub.resetExecuted();
  await runQuery(
    { table: "unidades", action: "select", filters: [] },
    rhCtx,
    TENANT_A,
  );

  assert.equal(stub.executed.length, 1);
  const { text, params } = stub.executed[0];
  assert.match(
    text,
    /t\."tenant_id" = \$\d+/,
    "o SELECT precisa restringir por tenant_id",
  );
  assert.ok(
    params.includes(TENANT_A),
    "o tenant validado deve entrar nos parâmetros",
  );
});

test("via_member/time_entries com tenant: WHERE usa subquery de membership", async () => {
  stub.resetExecuted();
  await runQuery(
    { table: "time_entries", action: "select", filters: [] },
    rhCtx,
    TENANT_A,
  );

  assert.equal(stub.executed.length, 1);
  const { text, params } = stub.executed[0];
  assert.match(
    text,
    /t\."user_id" IN \(SELECT user_id FROM public\.tenant_memberships WHERE tenant_id = \$\d+ AND status = 'ativo'\)/,
    "o SELECT precisa restringir aos membros do ente",
  );
  assert.ok(params.includes(TENANT_A));
});

test("sem tenant, RH em unidades: não vaza (resultado vazio)", async () => {
  stub.resetExecuted();
  const res = await runQuery(
    { table: "unidades", action: "select", filters: [] },
    rhCtx,
    null,
  );

  assert.equal(
    stub.executed.length,
    0,
    "sem tenant ativo, unidades não deve nem consultar o banco",
  );
  assert.deepEqual(res, { data: [], error: null });
});

test("sem tenant, RH em time_entries: cai para as próprias linhas", async () => {
  stub.resetExecuted();
  await runQuery(
    { table: "time_entries", action: "select", filters: [] },
    rhCtx,
    null,
  );

  assert.equal(stub.executed.length, 1);
  const { text, params } = stub.executed[0];
  assert.doesNotMatch(
    text,
    /tenant_memberships/,
    "sem tenant não há subquery de membership",
  );
  assert.match(text, /t\."user_id" =/, "deve restringir ao próprio user_id");
  assert.ok(
    params.includes(rhCtx.userId),
    "o filtro own usa o userId do contexto",
  );
});

test("global/user_roles no bootstrap (sem tenant) continua funcionando", async () => {
  stub.resetExecuted();
  // Reproduz o loadAccess do auth-context: lê o próprio user_roles antes de
  // haver tenant ativo. Não pode exigir tenant, senão o login trava.
  const res = await runQuery(
    {
      table: "user_roles",
      action: "select",
      filters: [{ col: "user_id", op: "eq", val: rhCtx.userId }],
    },
    rhCtx,
    null,
  );

  assert.equal(stub.executed.length, 1, "a consulta deve ter rodado");
  assert.ok(!res.error, "não pode falhar por falta de tenant");
  const { text } = stub.executed[0];
  assert.doesNotMatch(
    text,
    /tenant_memberships/,
    "tabela global não recebe predicado de tenant",
  );
});

test("direct/unidades insert com tenant: força tenant_id na linha gravada", async () => {
  stub.resetExecuted();
  await runQuery(
    {
      table: "unidades",
      action: "insert",
      values: { nome: "Nova unidade", codigo: "NU" },
      wantReturning: true,
    },
    // admin para passar na política de escrita de unidades
    { userId: rhCtx.userId, roles: ["admin"], perms: [] },
    TENANT_A,
  );

  assert.equal(stub.executed.length, 1);
  const { text, params } = stub.executed[0];
  assert.match(text, /"tenant_id"/, "a coluna tenant_id deve ser gravada");
  assert.ok(
    params.includes(TENANT_A),
    "o tenant ativo é forçado na linha nova",
  );
});

// ---------------------------------------------------------------------------
// Ponto probatório (O0-07): o shim só cria a própria batida; edição/exclusão
// são negadas (vão pelas server functions); leitura ignora as excluídas.
// ---------------------------------------------------------------------------

test("time_entries insert força user_id do contexto (ignora o da requisição)", async () => {
  stub.resetExecuted();
  await runQuery(
    {
      table: "time_entries",
      action: "insert",
      values: {
        user_id: "99999999-9999-9999-9999-999999999999",
        tipo: "entrada",
      },
      wantReturning: true,
    },
    rhCtx, // tem manage_employees — antes retornava {} e aceitava o user_id cru
    TENANT_A,
  );

  assert.equal(stub.executed.length, 1);
  const { params } = stub.executed[0];
  assert.ok(params.includes(rhCtx.userId), "o user_id gravado é o do contexto");
  assert.ok(
    !params.includes("99999999-9999-9999-9999-999999999999"),
    "o user_id da requisição é descartado",
  );
});

test("time_entries update é negado pelo shim", async () => {
  stub.resetExecuted();
  const res = await runQuery(
    {
      table: "time_entries",
      action: "update",
      values: { observacao: "x" },
      filters: [{ col: "id", op: "eq", val: "1" }],
    },
    rhCtx,
    TENANT_A,
  );
  assert.ok(res.error, "update deve ser recusado");
  assert.equal(stub.executed.length, 0, "não pode tocar o banco");
});

test("time_entries delete é negado pelo shim", async () => {
  stub.resetExecuted();
  const res = await runQuery(
    {
      table: "time_entries",
      action: "delete",
      filters: [{ col: "id", op: "eq", val: "1" }],
    },
    rhCtx,
    TENANT_A,
  );
  assert.ok(res.error, "delete deve ser recusado");
  assert.equal(stub.executed.length, 0, "não pode tocar o banco");
});

test("time_entries select filtra as batidas excluídas (deleted_at IS NULL)", async () => {
  stub.resetExecuted();
  await runQuery(
    { table: "time_entries", action: "select", filters: [] },
    rhCtx,
    TENANT_A,
  );
  assert.equal(stub.executed.length, 1);
  const { text } = stub.executed[0];
  assert.match(
    text,
    /"deleted_at" IS NULL/,
    "a leitura não pode trazer batidas excluídas",
  );
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
