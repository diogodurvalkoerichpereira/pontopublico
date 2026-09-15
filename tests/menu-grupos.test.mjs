/**
 * Sanfona do menu lateral: o clique sempre vence.
 *
 * A primeira versão forçava o grupo da página aberta a ficar visível
 * (`!temAtivo && fechados.includes(secao)`). A intenção era não deixar o usuário
 * perder de vista onde está, mas o efeito era o cabeçalho desse grupo **não
 * responder ao clique** — o usuário clicava em "Folha de Pagamento", estando numa
 * tela de folha, e nada acontecia. Menu que não responde parece quebrado.
 *
 * A decisão vive num módulo puro justamente porque foi ali que o erro morava, e
 * o projeto não tem renderizador de DOM para testar o componente.
 *
 * Mutação: voltar o `!temAtivo` derruba o primeiro caso.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "menu-test-"));
let m;

test("carrega o modulo", async () => {
  const out = join(dir, "menu.mjs");
  await build({
    entryPoints: ["src/lib/menu-grupos.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  m = await import(out);
});

test("o grupo da pagina aberta tambem fecha no clique", () => {
  // O caso que estava quebrado: o usuário está numa tela de Folha de Pagamento
  // e clica no cabeçalho desse mesmo grupo.
  const depoisDoClique = m.alternarGrupoFechado([], "Folha de Pagamento");
  assert.deepEqual(depoisDoClique, ["Folha de Pagamento"]);
  assert.equal(
    m.grupoFechado({
      barraAberta: true,
      secao: "Folha de Pagamento",
      fechados: depoisDoClique,
    }),
    true,
    "fecha mesmo sendo o grupo da página aberta",
  );
});

test("clicar de novo reabre", () => {
  const fechados = ["Recursos Humanos"];
  assert.deepEqual(m.alternarGrupoFechado(fechados, "Recursos Humanos"), []);
});

test("um grupo fechado nao afeta os outros", () => {
  const fechados = m.alternarGrupoFechado([], "Recursos Humanos");
  assert.equal(
    m.grupoFechado({ barraAberta: true, secao: "Geral", fechados }),
    false,
  );
});

test("com a barra em icones nao ha sanfona", () => {
  // Sem cabeçalho não há o que clicar; esconder os itens deixaria a barra vazia.
  assert.equal(
    m.grupoFechado({
      barraAberta: false,
      secao: "Folha de Pagamento",
      fechados: ["Folha de Pagamento"],
    }),
    false,
  );
});

test("navegar para dentro de um grupo fechado abre esse grupo", () => {
  const fechados = ["Folha de Pagamento", "Geral"];
  const depois = m.abrirGrupoDaNavegacao(fechados, "Folha de Pagamento");
  assert.deepEqual(depois, ["Geral"], "só o grupo navegado abre");
});

test("navegar nao mexe em nada quando o grupo ja esta aberto", () => {
  // Devolve a MESMA referência: é o que evita re-render a cada navegação.
  const fechados = ["Geral"];
  assert.equal(m.abrirGrupoDaNavegacao(fechados, "Recursos Humanos"), fechados);
  assert.equal(m.abrirGrupoDaNavegacao(fechados, undefined), fechados);
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
