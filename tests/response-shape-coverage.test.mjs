/**
 * Cobertura de forma da resposta: a tela consome o retorno do jeito certo.
 *
 * `/atas` caiu em produção com "(...).filter is not a function". A causa:
 * `getProcurementProcesses` devolve `{ processes, canManage }` — um OBJETO — e a
 * tela fazia `(processData ?? []).filter(...)`, lendo o objeto como lista.
 *
 * Duas defesas falharam ao mesmo tempo, e é por isso que este check existe:
 *
 * 1. `?? []` não protege. Ele cobre `null`/`undefined`, não formato errado: o
 *    objeto não é nulo, então passa direto e estoura no `.filter`.
 * 2. `as Array<...>` calou o TypeScript exatamente onde ele teria avisado. O
 *    `tsc` ficava verde, o build passava, e a página só quebrava no navegador do
 *    usuário — a tela inteira, não só a lista.
 *
 * Nenhum teste de servidor pega isso: a função de servidor está correta. O erro
 * está na costura entre as duas pontas, que é onde não havia rede.
 *
 * O check varre por AST o formato de retorno de cada `createServerFn` e, nas
 * telas, marca toda variável de `useQuery` que venha de uma função que devolve
 * objeto e seja usada como lista (`?? []`, `.map`, `.filter`, `.length`…).
 *
 * LIMITE CONHECIDO: a forma do retorno é lida do último `return` do handler.
 * Handlers que delegam a um helper (ver ALLOWLIST) ficam de fora — são 11 de
 * 313. Usar a propriedade (`dados?.processes ?? []`) nunca é marcado: ali a
 * lista sai da propriedade, que é o uso correto.
 *
 * Mutação: reintroduzir `(processData ?? []) as Array<…>` em atas.tsx derruba.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const libDir = join(root, "src", "lib");

/** Métodos que só existem em lista — usá-los denuncia a leitura errada. */
const DE_LISTA =
  "map|filter|reduce|forEach|some|every|find|findIndex|slice|sort|join|flatMap|length";

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Forma do retorno de cada server function: "objeto", "array" ou "?". */
function formasDeRetorno() {
  const forma = {};
  for (const f of readdirSync(libDir).filter((x) =>
    x.endsWith(".functions.ts"),
  )) {
    const src = readFileSync(join(libDir, f), "utf8");
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const txt = d.initializer.getText(sf);
        if (!/\bcreateServerFn\s*\(/.test(txt)) continue;
        const rets = [...txt.matchAll(/\n\s{4,8}return\s+([\s\S]{0,40})/g)].map(
          (m) => m[1].trim(),
        );
        const r = rets[rets.length - 1] ?? "";
        forma[d.name.text] = {
          tipo: /^\{/.test(r)
            ? "objeto"
            : /^query</.test(r) || /^\[/.test(r)
              ? "array"
              : "?",
          file: f,
        };
      }
    }
  }
  return forma;
}

test("nenhuma tela le resposta de objeto como se fosse lista", () => {
  const forma = formasDeRetorno();
  const telas = [
    ...walk(join(root, "src", "routes")),
    ...walk(join(root, "src", "components")),
  ];

  const suspeitos = [];
  for (const p of telas) {
    const src = readFileSync(p, "utf8");
    const alias = {};
    for (const m of src.matchAll(
      /const\s+(\w+)\s*=\s*useServerFn\(\s*(\w+)\s*\)/g,
    ))
      alias[m[1]] = m[2];

    for (const m of src.matchAll(
      /const\s*\{\s*data:\s*(\w+)[^}]*\}\s*=\s*useQuery\(\{([\s\S]{0,400}?)\}\);/g,
    )) {
      const nome = m[1];
      const chamada = m[2].match(/queryFn:\s*\(\)\s*=>\s*(\w+)\(/);
      const fn = chamada && alias[chamada[1]];
      if (!fn || forma[fn]?.tipo !== "objeto") continue;

      // `(?<![.\w])` impede casar o segundo nome em `dados?.dados ?? []`, que é
      // o uso CORRETO — ali a lista sai da propriedade, não do objeto.
      const comoLista = new RegExp(
        `(?<![.\\w])${nome}\\s*\\?\\?\\s*\\[\\]` +
          `|(?<![.\\w])${nome}\\s*\\??\\.\\s*(${DE_LISTA})\\b`,
      );
      if (comoLista.test(src))
        suspeitos.push(
          `${p.replace(root + "/", "")}: "${nome}" vem de ${fn} ` +
            `(${forma[fn].file}), que devolve um objeto`,
        );
    }
  }

  assert.deepEqual(
    suspeitos,
    [],
    `Tela lendo resposta de objeto como lista — quebra no navegador com ` +
      `".filter is not a function", e nem o tsc nem os testes de servidor pegam:\n  ` +
      `${suspeitos.join("\n  ")}\n` +
      `Use a propriedade da resposta (ex.: dados?.processes ?? []).`,
  );
});

test("a deteccao de forma cobre a maior parte das server functions", () => {
  // Se uma refatoração fizer a leitura do retorno parar de funcionar, o teste
  // acima ficaria verde sem checar nada. Este aqui é o alarme disso.
  const forma = Object.values(formasDeRetorno());
  const indeterminadas = forma.filter((f) => f.tipo === "?").length;
  assert.ok(
    forma.length > 250,
    `esperava mapear mais de 250 server functions, mapeou ${forma.length}`,
  );
  assert.ok(
    indeterminadas <= 20,
    `${indeterminadas} funções com forma de retorno indeterminada (limite 20): ` +
      `a leitura do retorno provavelmente parou de funcionar.`,
  );
});
