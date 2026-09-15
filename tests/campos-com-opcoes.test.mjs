/**
 * Campo com lista fechada não se digita à mão.
 *
 * Função, subfunção, natureza da despesa e fonte de recurso eram campo livre: o
 * usuário digitava o código de cabeça em toda dotação. Dois erros que só
 * aparecem no relatório, quando já é tarde:
 *
 * 1. Código inexistente por erro de digitação — o agrupamento cria uma linha
 *    para uma classificação que não existe, e ninguém percebe até a prestação
 *    de contas.
 * 2. O MESMO código com grafias diferentes ("3.1.90.11" e "319011"), que o
 *    agrupamento trata como coisas distintas e soma em lugares separados.
 *
 * Este check varre as telas e falha quando um `<Input>` de texto está ligado a
 * um campo que tem catálogo (`SelectClassificacao`) ou que pede o identificador
 * de outro registro (`*_id` — ninguém digita um UUID).
 *
 * Mutação: trocar um `SelectClassificacao` de volta por `<Input>` derruba.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Campos que têm catálogo, ou que referenciam outro registro. */
const COM_OPCOES =
  /(_id$|Id$|fonte_recurso|natureza_despesa|^funcao$|^subfuncao$)/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

test("nenhum campo com lista fechada e digitado em Input livre", () => {
  const telas = [
    ...walk(join(root, "src", "routes")),
    ...walk(join(root, "src", "components")),
  ];
  const achados = [];
  for (const p of telas) {
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/<Input\b([\s\S]{0,420}?)\/>/g)) {
      const v = m[1].match(/value=\{([^}]*)\}/);
      if (!v) continue;
      const campo = v[1]
        .trim()
        .replace(/[?!]/g, "")
        .split(".")
        .pop()
        .replace(/\s.*$/, "");
      if (!COM_OPCOES.test(campo)) continue;
      const linha = src.slice(0, m.index).split("\n").length;
      achados.push(`${p.replace(root + "/", "")}:${linha} — campo "${campo}"`);
    }
  }
  assert.deepEqual(
    achados,
    [],
    `Campo com lista fechada pedido como texto livre — convida a código ` +
      `inexistente e a grafias divergentes do mesmo código:\n  ${achados.join(
        "\n  ",
      )}\nUse <SelectClassificacao> (catálogo) ou um <Select> dos registros.`,
  );
});
