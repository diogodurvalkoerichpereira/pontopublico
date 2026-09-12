/**
 * Registro central de conformidade dos artefatos de saída.
 *
 * Motivação: vários geradores de arquivo do sistema levavam nomes de padrões
 * oficiais (CNAB 240, TCE-CE SIM, SIOPE, MANAD) sem implementar esses padrões.
 * Um arquivo rotulado `CNAB240-v1` que produz registros de 47 caracteres, onde
 * o padrão exige 240 posições, induz a erro tanto o operador quanto qualquer
 * declaração de conformidade apresentada em licitação.
 *
 * Regra do projeto: nenhum artefato pode ser rotulado com o nome de um padrão
 * oficial antes de ter sido aceito pelo sistema oficial correspondente. Até lá,
 * o rótulo carrega o prefixo RASCUNHO e o status declarado aqui acompanha a
 * resposta da função que o gera.
 */

export type ConformanceStatus =
  /** Homologado contra o sistema oficial. Pode ser declarado em edital. */
  | "conforme"
  /** Gera arquivo, mas em formato próprio. Não atende ao padrão oficial. */
  | "rascunho"
  /** Não produz saída utilizável. A operação falha com erro explícito. */
  | "nao-implementado";

export interface ConformanceNotice {
  /** Identificador do artefato gerado. */
  artefato: string;
  status: ConformanceStatus;
  /** Padrão oficial que este artefato NÃO atende, quando aplicável. */
  padraoOficialPendente?: string;
  /** O que falta para atingir a conformidade. */
  pendencias: readonly string[];
}

const NOTICES = {
  "remessa-bancaria": {
    artefato: "remessa-bancaria",
    status: "rascunho",
    padraoOficialPendente: "FEBRABAN CNAB 240",
    pendencias: [
      "registros de 240 posições fixas (hoje: linhas de comprimento variável)",
      "header de arquivo, header de lote, segmentos A/B/C, trailer de lote e trailer de arquivo",
      "código de convênio, data de pagamento, finalidade do crédito e dígitos verificadores",
      "homologação junto a pelo menos uma instituição bancária",
    ],
  },
  "exportacao-oficial": {
    artefato: "exportacao-oficial",
    status: "rascunho",
    padraoOficialPendente: "layouts TCE-CE SIM, SIOPE, MANAD e PCS",
    pendencias: [
      "cada layout tem estrutura própria; hoje três deles compartilham o mesmo CSV de 5 colunas",
      "conjunto completo de campos exigido por cada layout",
      "validação contra o schema oficial publicado pelo órgão",
      "aceite do arquivo pelo sistema receptor do órgão",
    ],
  },
  "esocial-transmissao": {
    artefato: "esocial-transmissao",
    status: "nao-implementado",
    padraoOficialPendente: "eSocial (assinatura ICP-Brasil e transmissão)",
    pendencias: [
      "geração do XML dos eventos a partir dos dados da folha",
      "assinatura digital XMLDSig com certificado A1/A3",
      "transmissão ao ambiente da Receita e tratamento de protocolo/recibo",
    ],
  },
} as const satisfies Record<string, ConformanceNotice>;

export type ConformanceArtifact = keyof typeof NOTICES;

export function conformanceOf(
  artefato: ConformanceArtifact,
): ConformanceNotice {
  return NOTICES[artefato];
}

/**
 * Lançado quando uma operação não pode ser executada honestamente porque a
 * integração oficial não existe. Preferimos falhar de forma explícita a
 * registrar um estado de sucesso que não corresponde ao que aconteceu.
 */
export class NotImplementedConformanceError extends Error {
  readonly notice: ConformanceNotice;

  constructor(artefato: ConformanceArtifact) {
    const notice = conformanceOf(artefato);
    super(
      `Operação indisponível: ${notice.padraoOficialPendente ?? notice.artefato} não implementado. ` +
        `Pendências: ${notice.pendencias.join("; ")}.`,
    );
    this.name = "NotImplementedConformanceError";
    this.notice = notice;
  }
}
