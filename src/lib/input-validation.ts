/**
 * Mensagem de erro de validação em português, para o usuário.
 *
 * O padrão da casa é `.validator((data) => Schema.parse(data))`. Quando o zod
 * recusa, `ZodError.message` é o **JSON cru das issues** — e é isso que chegava
 * ao `toast.error(error.message)` das 122 telas: um blob de `{"code":
 * "too_small","minimum":2,...}` na cara do usuário, em inglês, sem dizer qual
 * campo nem o que fazer. `parseInput` troca isso por uma frase que nomeia o
 * campo e a regra, e é o único ponto que precisa mudar para as ~300 funções de
 * servidor.
 *
 * Módulo **puro**: sem `node:*`, sem `*.server`. Pode ser importado do cliente
 * (as telas usam `rotuloDoCampo` para nomear campos nas mensagens locais).
 */
import { z } from "zod";

/**
 * Rótulos de campos cujo nome técnico não se traduz sozinho. O resto cai no
 * fallback: `valor_lancado` -> "valor lancado". Só entra aqui o que ficaria
 * errado ou obscuro sem tradução.
 */
const ROTULOS: Record<string, string> = {
  tenant_id: "entidade",
  appropriation_id: "dotação",
  commitment_id: "empenho",
  account_id: "conta",
  contract_id: "contrato",
  credit_id: "crédito",
  cycle_id: "folha",
  employment_link_id: "vínculo",
  process_id: "licitação",
  property_id: "imóvel",
  punch_id: "marcação",
  rubric_id: "rubrica",
  origem_id: "dotação de origem",
  destino_id: "dotação de destino",
  valor_lancado: "valor lançado",
  valor_acrescimo: "acréscimo",
  valor_orcado: "valor orçado",
  valor_total: "valor total",
  valor_transmissao: "valor da transmissão",
  preco_unitario: "preço unitário",
  saldo_extrato: "saldo do extrato",
  data_referencia: "data de referência",
  data_empenho: "data do empenho",
  data_pagamento: "data do pagamento",
  data_emissao: "data de emissão",
  data_aditivo: "data do aditivo",
  reference_month: "competência",
  exercicio: "exercício",
  bank_code: "código do banco",
  contribuinte_documento: "CPF/CNPJ do contribuinte",
  fonte_recurso: "fonte de recurso",
  inscricao_municipal: "inscrição municipal",
  natureza_despesa: "natureza da despesa",
  unidade_orcamentaria: "unidade orçamentária",
  nova_vigencia_fim: "nova vigência (fim)",
  aliquota_iss: "alíquota de ISS",
  holiday_type: "tipo de feriado",
  overtime_rubric_id: "rubrica de horas extras",
  absence_rubric_id: "rubrica de faltas",
  overtime_multiplier: "adicional de hora extra",
  monthly_base_hours: "horas mensais",
  tolerance_minutes: "tolerância em minutos",
};

/** Nome de campo legível: do dicionário, ou `snake_case` -> "snake case". */
export function rotuloDoCampo(caminho: Array<string | number>): string {
  if (caminho.length === 0) return "formulário";
  const chave = caminho.map(String).join(".");
  const ultimo = String(caminho[caminho.length - 1]);
  return (
    ROTULOS[chave] ?? ROTULOS[ultimo] ?? ultimo.replace(/_/g, " ").toLowerCase()
  );
}

const TIPOS: Record<string, string> = {
  string: "texto",
  number: "número",
  boolean: "sim/não",
  date: "data",
  array: "lista",
  object: "objeto",
};

const FORMATOS: Record<string, string> = {
  email: "um e-mail válido",
  uuid: "uma seleção válida",
  url: "uma URL válida",
  date: "uma data no formato AAAA-MM-DD",
  datetime: "uma data e hora válidas",
  regex: "o formato esperado",
};

/** Uma issue do zod -> uma frase em português que nomeia o campo e a regra. */
function descreverIssue(issue: z.ZodIssue): string {
  const campo = rotuloDoCampo(issue.path);
  switch (issue.code) {
    case "invalid_type":
      // `undefined` recebido é campo não preenchido — é o caso mais comum e
      // merece a mensagem mais direta, não "esperado texto, recebido undefined".
      if (issue.received === "undefined" || issue.received === "null")
        return `Informe ${campo}.`;
      return `${campo}: esperado ${TIPOS[issue.expected] ?? issue.expected}.`;
    case "too_small": {
      const min = issue.minimum;
      if (issue.type === "string")
        return min === 1
          ? `Informe ${campo}.`
          : `${campo}: mínimo de ${min} caracteres.`;
      if (issue.type === "array")
        return `${campo}: selecione ao menos ${min} item(ns).`;
      return issue.inclusive
        ? `${campo}: valor mínimo é ${min}.`
        : `${campo}: precisa ser maior que ${min}.`;
    }
    case "too_big": {
      const max = issue.maximum;
      if (issue.type === "string")
        return `${campo}: máximo de ${max} caracteres.`;
      if (issue.type === "array") return `${campo}: no máximo ${max} item(ns).`;
      return issue.inclusive
        ? `${campo}: valor máximo é ${max}.`
        : `${campo}: precisa ser menor que ${max}.`;
    }
    case "invalid_string":
      return `${campo}: informe ${FORMATOS[String(issue.validation)] ?? "um valor válido"}.`;
    case "invalid_enum_value":
      return `${campo}: valor inválido. Opções: ${issue.options.join(", ")}.`;
    case "not_finite":
      return `${campo}: informe um número válido.`;
    case "invalid_date":
      return `${campo}: data inválida.`;
    case "unrecognized_keys":
      return `Campos não reconhecidos: ${issue.keys.join(", ")}.`;
    case "custom":
      // Mensagens de `.refine()` já são escritas em português pelo autor da
      // regra — repassar como estão é mais preciso que reescrever.
      return issue.message;
    default:
      return issue.message;
  }
}

/** Quantas frases cabem num toast antes de virar parede de texto. */
const MAX_ISSUES = 3;

/** Junta as issues numa mensagem só, sem repetir e sem estourar o toast. */
export function mensagemDeValidacao(erro: z.ZodError): string {
  const frases: string[] = [];
  for (const issue of erro.issues) {
    const frase = descreverIssue(issue);
    if (!frases.includes(frase)) frases.push(frase);
  }
  if (frases.length <= MAX_ISSUES) return frases.join(" ");
  const restantes = frases.length - MAX_ISSUES;
  return `${frases.slice(0, MAX_ISSUES).join(" ")} (e mais ${restantes} problema${restantes > 1 ? "s" : ""}.)`;
}

/**
 * Valida a entrada de uma server function. Substitui `Schema.parse(data)` no
 * `.validator(...)`: mesmo resultado no caminho feliz, mensagem em português
 * no caminho de erro.
 */
export function parseInput<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
): z.infer<S> {
  const resultado = schema.safeParse(data);
  if (resultado.success) return resultado.data;
  throw new Error(mensagemDeValidacao(resultado.error));
}
