// Motor de escrita de registros de LARGURA FIXA (posicional). Puro, sem I/O:
// recebe uma especificacao declarativa de campos (posicao/tamanho/tipo) e os
// valores, e devolve a linha exata. E a base para CNAB 240 (remessa bancaria,
// O1-07) e para AFD/AEJ do ponto (Portaria 671, O1-03b) — formatos posicionais.
//
// NAO declara conformidade com nenhum padrao: e so o formatador. A conformidade
// de um layout especifico depende de aceite pelo sistema oficial correspondente
// (banco, MTE) — ver src/lib/conformance.ts e a Definicao de Pronto (CLAUDE.md).

export type FieldType = "num" | "alfa";

export interface FieldSpec {
  /** Nome do campo (documentacao/erro). */
  name: string;
  /** Posicao inicial 1-based (inclusiva), como nos manuais FEBRABAN/MTE. */
  start: number;
  /** Tamanho em caracteres. */
  length: number;
  /** num: so digitos, alinhado a direita, preenchido com zeros. alfa: alinhado a
   *  esquerda, preenchido com espacos, maiusculo. */
  type: FieldType;
}

/**
 * Formata um valor conforme o tipo/tamanho do campo.
 * - num: remove tudo que nao e digito, alinha a direita com zeros; se exceder,
 *   mantem os digitos MENOS significativos (corte a esquerda).
 * - alfa: converte para string, maiusculo, alinha a esquerda com espacos; se
 *   exceder, corta a direita.
 */
export function formatField(value: unknown, spec: FieldSpec): string {
  if (spec.length <= 0) throw new Error(`Campo ${spec.name}: tamanho invalido`);
  if (spec.type === "num") {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.padStart(spec.length, "0").slice(-spec.length);
  }
  const text = String(value ?? "")
    .toUpperCase()
    .replace(/[\r\n]/g, " ");
  return text.padEnd(spec.length, " ").slice(0, spec.length);
}

/**
 * Escreve um registro completo a partir de uma especificacao ORDENADA e contigua
 * (posicoes 1..recordLength, sem buracos nem sobreposicao) e de um mapa de
 * valores por nome de campo. Valida a cobertura e o comprimento final — a
 * garantia de que a linha tem exatamente `recordLength` posicoes.
 */
export function writeRecord(
  specs: FieldSpec[],
  values: Record<string, unknown>,
  recordLength: number,
): string {
  let expected = 1;
  let line = "";
  for (const spec of specs) {
    if (spec.start !== expected)
      throw new Error(
        `Campo ${spec.name}: comeca em ${spec.start}, esperado ${expected} (spec nao contigua)`,
      );
    line += formatField(values[spec.name], spec);
    expected += spec.length;
  }
  if (line.length !== recordLength)
    throw new Error(
      `Registro com ${line.length} posicoes, esperado ${recordLength}`,
    );
  return line;
}

/** Soma dos tamanhos da spec — util para conferir que cobre o registro inteiro. */
export function specLength(specs: FieldSpec[]): number {
  return specs.reduce((total, spec) => total + spec.length, 0);
}
