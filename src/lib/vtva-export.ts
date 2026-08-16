// Geração do CSV de benefícios (VT/VA) no layout da operadora.
// Formato do arquivo de referência (ATIVOS ...csv):
//   - 33 colunas + separador ";" + ";" final por linha
//   - encoding ISO-8859-1 (Latin1), quebras CRLF
//   - decimais com vírgula, datas dd/MM/yy

export const VTVA_HEADER = [
  "CNPJ", "CEP", "LOGRADOURO", "NÚMERO", "COMPLEMENTO", "PONTO REFERENCIA", "UF", "ESTADO",
  "MATRÍCULA", "NOME DO FUNCIONÁRIO", "CPF", "RG", "DATA DE NASCIMENTO", "CARGO", "DEPARTAMENTO", "NOME DA MÃE",
  "BENEFÍCIO DO FUNCIONÁRIO", "VALOR UNITÁRIO", "QUANTIDADE DIÁRIA", "PERÍODO DE DIAS TRABALHADOS", "TIPO VALOR", "REDE RECARGA",
  "CEP RESIDENCIAL", "LOGRADOURO RESIDENCIAL", "NÚMERO RESIDENCIAL", "COMPLEMENTO RESIDENCIAL", "ESTADO CIVIL",
  "DATA DE EMISSÃO DO RG", "ÓRGÃO EXPEDIDOR", "ESTADO EMISSÃO RG", "CHAVE PIX", "TIPO CHAVE PIX", "BANCO",
] as const;

// Ordem dos campos da linha, alinhada 1:1 com VTVA_HEADER.
export const VTVA_FIELDS = [
  "cnpj", "cep_empresa", "logradouro_empresa", "numero_empresa", "complemento_empresa", "ponto_referencia", "uf_empresa", "estado_empresa",
  "matricula", "nome", "cpf", "rg", "data_nascimento", "cargo", "departamento", "nome_mae",
  "beneficio", "valor_unitario", "quantidade_diaria", "dias_trabalhados", "tipo_valor", "rede_recarga",
  "cep_residencial", "logradouro_residencial", "numero_residencial", "complemento_residencial", "estado_civil",
  "data_emissao_rg", "orgao_expedidor", "estado_emissao_rg", "chave_pix", "tipo_chave_pix", "banco",
] as const;

export type VtVaField = (typeof VTVA_FIELDS)[number];
export type VtVaRow = Record<VtVaField, string>;

/** Número → string com vírgula decimal e 2 casas (ex.: 5.4 → "5,40"). Vazio se nulo. */
export function fmtNum(n: number | null | undefined, decimals = 2): string {
  if (n == null || Number.isNaN(Number(n))) return "";
  return Number(n).toFixed(decimals).replace(".", ",");
}

/** Data "YYYY-MM-DD" (ou ISO) → "dd/MM/yy". Vazio se ausente/ inválida. */
export function fmtDateBR(v: string | null | undefined): string {
  if (!v) return "";
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y.slice(2)}`;
}

function csvCell(value: string): string {
  const v = value ?? "";
  // Escapa apenas quando necessário (separador, aspas ou quebra de linha).
  if (/[;"\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** Monta o conteúdo CSV completo (com cabeçalho), terminador ";" e CRLF. */
export function buildVtVaCsv(rows: VtVaRow[]): string {
  const lines: string[] = [];
  lines.push(VTVA_HEADER.map((h) => csvCell(h)).join(";") + ";");
  for (const row of rows) {
    lines.push(VTVA_FIELDS.map((f) => csvCell(row[f] ?? "")).join(";") + ";");
  }
  return lines.join("\r\n") + "\r\n";
}

/** Converte string para bytes Latin1 (ISO-8859-1). Caracteres fora da faixa viram "?". */
function toLatin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out[i] = code < 256 ? code : 63; // 63 = "?"
  }
  return out;
}

/** Dispara o download do CSV em Latin1, no padrão de download já usado no app. */
export function downloadVtVaCsv(filename: string, csv: string): void {
  const blob = new Blob([toLatin1Bytes(csv)], { type: "text/csv;charset=iso-8859-1" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
