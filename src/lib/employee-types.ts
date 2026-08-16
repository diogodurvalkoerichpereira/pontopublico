export type EmployeeStatus = "ativo" | "ferias" | "afastado" | "desligado";
export type DocumentoStatus = "pendente" | "aprovado" | "rejeitado";
export type DocumentoCategoria = "identificacao_pessoal" | "trabalhista" | "comprovante" | "livre";

export const STATUS_LABEL: Record<EmployeeStatus, string> = {
  ativo: "Ativo",
  ferias: "Férias",
  afastado: "Afastado",
  desligado: "Desligado",
};

export const CATEGORIA_LABEL: Record<DocumentoCategoria, string> = {
  identificacao_pessoal: "Identificação pessoal",
  trabalhista: "Trabalhista",
  comprovante: "Comprovante",
  livre: "Outro",
};
