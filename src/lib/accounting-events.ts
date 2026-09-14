// Códigos dos eventos contabilizáveis por roteiro (O2-06 / O3-11c). Módulo PURO —
// sem imports de servidor — para que rotas (cliente) e o helper de escrituração
// (servidor) compartilhem a mesma fonte única sem cruzar a barreira cliente/servidor.
// O3-11c acrescenta os três da baixa de bem (depreciação acumulada,
// desincorporação do líquido como VPD, alienação como VPA). O3-11d acrescenta os
// dois da reavaliação (ganho/perda de valor justo, sem saída do acervo).
export const ACCOUNTING_EVENT_CODES = [
  "empenho",
  "empenho_anulacao",
  "liquidacao",
  "pagamento",
  "baixa_bem_depreciacao",
  "baixa_bem_desincorporacao",
  "baixa_bem_alienacao",
  "reavaliacao_positiva",
  "reavaliacao_negativa",
] as const;
export type AccountingEventCode = (typeof ACCOUNTING_EVENT_CODES)[number];
