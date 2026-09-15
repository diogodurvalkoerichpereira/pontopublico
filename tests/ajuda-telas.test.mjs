/**
 * "Como fazer": a ajuda de tela corresponde a telas que existem.
 *
 * O texto de ajuda é a documentação que envelhece mais rápido, porque nada
 * quebra quando ela fica errada. Duas maneiras de apodrecer, e este check pega
 * as duas:
 *
 * 1. Ajuda órfã — escrita para uma rota que foi renomeada ou removida. O painel
 *    simplesmente nunca aparece, e ninguém nota.
 * 2. Ajuda que promete o que a tela não faz — este check não lê a mente, mas
 *    exige que cada passo tenha ação e texto, para que um item vazio não passe.
 *
 * Também confere a resolução por rota-mãe, que é o que faz `/rh/funcionarios/123`
 * aproveitar a ajuda de `/rh/funcionarios`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "ajuda-test-"));
let mod;

test("carrega o modulo de ajuda", async () => {
  const out = join(dir, "ajuda.mjs");
  await build({
    entryPoints: ["src/lib/ajuda-telas.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  mod = await import(out);
  assert.equal(typeof mod.ajudaDaRota, "function");
});

/** Rotas reais, derivadas dos arquivos de `src/routes`. */
function rotasExistentes() {
  const rotas = new Set();
  for (const f of readdirSync("src/routes")) {
    if (!f.endsWith(".tsx")) continue;
    const base = f.replace(/\.tsx$/, "");
    if (base === "__root") continue;
    // `rh.pessoas.tsx` -> `/rh/pessoas`; `index` -> `/`
    rotas.add("/" + base.replace(/\./g, "/").replace(/\/?index$/, ""));
  }
  for (const f of readdirSync("src/routes", { withFileTypes: true })) {
    if (!f.isDirectory()) continue;
    for (const sub of readdirSync(join("src/routes", f.name)))
      if (sub.endsWith(".tsx"))
        rotas.add(`/${f.name}/${sub.replace(/\.tsx$/, "")}`);
  }
  return rotas;
}

/** Chaves declaradas no mapa de ajuda, lidas do fonte. */
function rotasComAjuda() {
  const src = readFileSync("src/lib/ajuda-telas.ts", "utf8");
  const corpo = src.slice(src.indexOf("const AJUDA"));
  return [...corpo.matchAll(/^ {2}"(\/[^"]*)":/gm)].map((m) => m[1]);
}

test("toda ajuda aponta para uma rota que existe", () => {
  const existentes = rotasExistentes();
  const orfas = rotasComAjuda().filter((r) => !existentes.has(r));
  assert.deepEqual(
    orfas,
    [],
    `Ajuda escrita para rota inexistente — o painel nunca apareceria:\n  ${orfas.join(
      "\n  ",
    )}\nCorrija o caminho ou remova a entrada.`,
  );
});

test("todo passo tem acao e como preenchidos", () => {
  const vazios = [];
  for (const rota of rotasComAjuda()) {
    const ajuda = mod.ajudaDaRota(rota);
    assert.ok(ajuda, `ajudaDaRota devolveu nada para ${rota}`);
    assert.ok(ajuda.titulo?.trim(), `${rota}: sem título`);
    assert.ok(ajuda.resumo?.trim(), `${rota}: sem resumo`);
    assert.ok(ajuda.passos.length > 0, `${rota}: sem nenhum passo`);
    for (const p of ajuda.passos)
      if (!p.acao?.trim() || !p.como?.trim())
        vazios.push(`${rota}: passo "${p.acao ?? ""}" incompleto`);
  }
  assert.deepEqual(vazios, []);
});

test("rota com parametro aproveita a ajuda da tela-mae", () => {
  const mae = mod.ajudaDaRota("/contratos");
  const filha = mod.ajudaDaRota("/contratos/abc-123");
  assert.ok(mae, "a tela-mãe tem ajuda");
  assert.equal(filha?.titulo, mae.titulo);
});

test("rota sem ajuda escrita devolve null, sem quebrar", () => {
  assert.equal(mod.ajudaDaRota("/rota/que/nao/existe"), null);
  assert.equal(mod.ajudaDaRota("/"), null);
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
