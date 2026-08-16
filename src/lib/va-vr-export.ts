// Exportação da planilha de VA / VR no layout da operadora (XLSX, 8 colunas).
// Layout do arquivo de referência:
//   Matrícula | CPF | Nome do Beneficiário | Data de Nascimento | Departamento |
//   Unidade de Entrega | Valor Mensal do Benefício | Número do contrato

export type BeneficioAlimentacao = "VA" | "VR";

/** Contrato da operadora por tipo de benefício. */
export const NUMERO_CONTRATO: Record<BeneficioAlimentacao, string> = {
  VA: "6184590006 - TAE",
  VR: "6184590015 - TRE",
};

export const VA_VR_HEADER = [
  "Matrícula",
  "CPF",
  "Nome do Beneficiário",
  "Data de Nascimento",
  "Departamento",
  "Unidade de Entrega",
  "Valor Mensal do Benefício",
  "Número do contrato",
] as const;

export interface VaVrRow {
  matricula: string;
  cpf: string;
  nome: string;
  /** "YYYY-MM-DD" (ou ISO). Vazio quando não cadastrada. */
  data_nascimento: string | null;
  departamento: string;
  unidade_entrega: string;
  /** Valor mensal já apurado (valor unitário × quantidade diária × dias trabalhados). */
  valor_mensal: number;
  numero_contrato: string;
}

/** "YYYY-MM-DD" → Date local (evita o deslocamento de fuso do construtor ISO). */
function toDate(v: string | null): Date | null {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d));
}

/** Gera e baixa o .xlsx no layout do anexo. */
export async function downloadVaVrXlsx(filename: string, rows: VaVrRow[]): Promise<void> {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  const ws = wb.addWorksheet("Planilha1");

  ws.addRow([...VA_VR_HEADER]);
  ws.getRow(1).font = { bold: true };

  for (const r of rows) {
    ws.addRow([
      r.matricula,
      r.cpf,
      r.nome,
      toDate(r.data_nascimento),
      r.departamento,
      r.unidade_entrega,
      r.valor_mensal,
      r.numero_contrato,
    ]);
  }

  ws.getColumn(4).numFmt = "dd/mm/yyyy";
  ws.getColumn(7).numFmt = "#,##0.00";
  ws.columns.forEach((col, i) => {
    col.width = [16, 16, 38, 18, 22, 22, 24, 22][i] ?? 16;
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
