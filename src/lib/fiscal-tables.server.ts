// Carregamento das tabelas fiscais vigentes para o avaliador de folha (O1-01).
// SOMENTE servidor. Roda ANTES do laço puro de cálculo: resolve, por código, a
// versão publicada vigente na competência (do ente, senão a nacional), confere o
// checksum e devolve um Map pronto para injetar em `evaluateFormulaAst` — o
// avaliador em si nunca toca o banco (ADR 0003).
import { query } from "./db.server";
import { checksumFiscalBrackets } from "./payroll-formula.server";
import type { FiscalTable, FiscalBracket } from "./payroll-formula";

interface VersionRow {
  code: string;
  version_id: string;
  checksum: string;
  brackets: FiscalBracket[];
  tenant_id: string | null;
}

/**
 * Tabelas fiscais publicadas e vigentes na `competencia` (uma data), por código.
 * Prefere a versão do ente à nacional (`tenant_id` nulo). Recompõe e **verifica**
 * o checksum de cada versão — divergência lança, para o número não sair de uma
 * tabela adulterada.
 */
export async function loadFiscalTables(
  tenantId: string,
  competencia: string,
): Promise<Map<string, FiscalTable>> {
  const rows = await query<VersionRow>(
    `select ft.code,
            v.id as version_id,
            v.checksum,
            v.brackets,
            v.tenant_id
     from public.fiscal_table_versions v
     join public.fiscal_tables ft on ft.id = v.fiscal_table_id
     where v.status = 'publicada'
       and (v.tenant_id is null or v.tenant_id = $1)
       and v.valid_from <= $2
       and (v.valid_to is null or v.valid_to >= $2)
     order by v.tenant_id nulls last`,
    [tenantId, competencia],
  );

  const tables = new Map<string, FiscalTable>();
  for (const row of rows) {
    // A ordenação põe as do ente antes das nacionais: a primeira por código vence.
    if (tables.has(row.code)) continue;
    const recomputed = checksumFiscalBrackets(row.brackets);
    if (recomputed !== row.checksum) {
      throw new Error(`Checksum de tabela fiscal divergente: ${row.code}`);
    }
    tables.set(row.code, {
      versionId: row.version_id,
      checksum: row.checksum,
      brackets: row.brackets,
    });
  }
  return tables;
}
