/**
 * Mensagem de erro ao usuário: validação de entrada e erro do banco.
 *
 * Duas fontes de texto cru chegavam ao `toast.error(error.message)` das telas:
 *
 * 1. `ZodError.message` é o **JSON das issues**. O usuário via
 *    `[{"code":"too_small","minimum":2,"type":"string",...}]` — em inglês, sem
 *    dizer qual campo nem o que fazer. Eram ~300 funções de servidor assim.
 * 2. Violação de constraint do Postgres chega como o texto interno do banco:
 *    `new row for relation "x" violates check constraint "y"`.
 *
 * Estes testes executam os dois tradutores e conferem o texto que o usuário vê.
 *
 * Mutação: devolver `erro.message` cru em `mensagemDeValidacao`, ou devolver o
 * erro sem traduzir em `traduzirErroDoBanco`, derruba.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "validacao-test-"));

/** Executa e devolve o erro lancado (assert.throws nao devolve o erro). */
function capturar(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new assert.AssertionError({ message: "esperava um erro, nao veio" });
}
let mod;
let dbErros;

async function bundle(entry, name) {
  const out = join(dir, name);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
    external: ["node:*"],
  });
  return import(out);
}

test("carrega os modulos", async () => {
  mod = await bundle("src/lib/input-validation.ts", "iv.mjs");
  dbErros = await bundle("src/lib/db-errors.server.ts", "de.mjs");
  assert.equal(typeof mod.parseInput, "function");
});

test("campo em branco vira 'Informe <campo>', nao JSON", async () => {
  const { z } = await import("zod");
  const S = z.object({
    tenant_id: z.string().uuid(),
    contribuinte: z.string().trim().min(2).max(200),
  });
  const erro = capturar(() =>
    mod.parseInput(S, { tenant_id: "00000000-0000-4000-8000-000000000000" }),
  );
  assert.equal(erro.message, "Informe contribuinte.");
  // O que o usuário NÃO pode mais ver:
  assert.ok(!erro.message.includes("{"), "sem JSON");
  assert.ok(!erro.message.includes("too_small"), "sem código do zod");
  assert.ok(!/[A-Z][a-z]+ must contain/.test(erro.message), "sem inglês");
});

test("o campo e nomeado em portugues, nao pelo nome tecnico", async () => {
  const { z } = await import("zod");
  const S = z.object({
    valor_lancado: z.number().positive(),
    contribuinte_documento: z.string().min(3),
    natureza_despesa: z.string().min(1),
  });
  const erro = capturar(() =>
    mod.parseInput(S, {
      valor_lancado: -5,
      contribuinte_documento: "x",
      natureza_despesa: "3.1.90",
    }),
  );
  assert.match(erro.message, /valor lançado/);
  assert.match(erro.message, /CPF\/CNPJ do contribuinte/);
});

test("limites de texto e numero viram frase com o limite", async () => {
  const { z } = await import("zod");
  const S = z.object({ nome: z.string().max(5), idade: z.number().max(10) });
  const erro = capturar(() =>
    mod.parseInput(S, { nome: "abcdefgh", idade: 99 }),
  );
  assert.match(erro.message, /nome: máximo de 5 caracteres\./);
  assert.match(erro.message, /idade: valor máximo é 10\./);
});

test("formato de e-mail, uuid e data sao explicados", async () => {
  const { z } = await import("zod");
  const S = z.object({
    email: z.string().email(),
    conta: z.string().uuid(),
    vencimento: z.string().date(),
  });
  const erro = capturar(() =>
    mod.parseInput(S, { email: "x", conta: "y", vencimento: "31/12/2026" }),
  );
  assert.match(erro.message, /e-mail válido/);
  // "uuid" não quer dizer nada para quem preenche: é uma seleção que faltou.
  assert.match(erro.message, /conta: informe uma seleção válida/);
});

test("enum lista as opcoes aceitas", async () => {
  const { z } = await import("zod");
  const S = z.object({ tributo: z.enum(["IPTU", "ISS", "TAXA"]) });
  const erro = capturar(() => mod.parseInput(S, { tributo: "IPVA" }));
  assert.match(erro.message, /Opções: IPTU, ISS, TAXA/);
});

test("mensagem de .refine() do autor passa intacta", async () => {
  const { z } = await import("zod");
  const S = z
    .object({ a: z.number(), b: z.number() })
    .refine((v) => v.a <= v.b, { message: "O início não pode ser após o fim" });
  const erro = capturar(() => mod.parseInput(S, { a: 5, b: 1 }));
  assert.equal(erro.message, "O início não pode ser após o fim");
});

test("muitos erros nao viram parede de texto", async () => {
  const { z } = await import("zod");
  const S = z.object({
    a: z.string().min(1),
    b: z.string().min(1),
    c: z.string().min(1),
    d: z.string().min(1),
    e: z.string().min(1),
  });
  const erro = capturar(() => mod.parseInput(S, {}));
  assert.match(erro.message, /e mais 2 problemas/);
  assert.ok(erro.message.length < 200, "mensagem cabe num toast");
});

test("entrada valida passa e devolve o dado parseado", async () => {
  const { z } = await import("zod");
  const S = z.object({ n: z.coerce.number(), s: z.string().trim() });
  assert.deepEqual(mod.parseInput(S, { n: "42", s: "  ok  " }), {
    n: 42,
    s: "ok",
  });
});

// --- erro do banco ---

function pgErro(props) {
  const e = new Error(props.message ?? "erro interno do postgres");
  Object.assign(e, props);
  return e;
}

test("check constraint conhecida explica o que fazer", () => {
  const t = dbErros.traduzirErroDoBanco(
    pgErro({
      code: "23514",
      constraint: "budget_empenhado_bloqueado_teto",
      table: "budget_appropriations",
      message:
        'new row for relation "budget_appropriations" violates check constraint "budget_empenhado_bloqueado_teto"',
    }),
  );
  assert.match(t.message, /Libere o contingenciamento/);
  assert.ok(!t.message.includes("budget_appropriations"), "sem nome de tabela");
  assert.ok(!t.message.includes("constraint"), "sem jargão de banco");
  // O original fica no cause, para o log do servidor.
  assert.match(t.cause.message, /violates check constraint/);
});

test("unique, FK e not-null viram frases por codigo", () => {
  const dup = dbErros.traduzirErroDoBanco(
    pgErro({ code: "23505", message: "duplicate key value violates ..." }),
  );
  assert.match(dup.message, /Já existe um registro/);

  const fk = dbErros.traduzirErroDoBanco(
    pgErro({
      code: "23503",
      detail: "Key (id)=(1) is still referenced from table x.",
    }),
  );
  assert.match(fk.message, /outros registros dependem dele/);

  const nn = dbErros.traduzirErroDoBanco(
    pgErro({ code: "23502", column: "valor_total" }),
  );
  assert.match(nn.message, /valor total/);
});

test("raise exception das triggers ja esta em portugues e passa intacta", () => {
  // As triggers do projeto escrevem em português: retraduzir perderia o motivo.
  const original = pgErro({
    code: "P0001",
    message: "Marcacao de ponto e imutavel",
  });
  assert.equal(dbErros.traduzirErroDoBanco(original), original);
});

test("erro que nao e do postgres passa intacto", () => {
  const original = new Error("Sem permissao: budget.manage");
  assert.equal(dbErros.traduzirErroDoBanco(original), original);
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
