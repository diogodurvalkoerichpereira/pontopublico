/**
 * Erro do PostgreSQL -> frase para o usuário.
 *
 * SOMENTE servidor. Quando uma constraint do banco dispara, o driver `pg` joga
 * um erro cujo `message` é o texto interno do Postgres — `new row for relation
 * "budget_appropriations" violates check constraint
 * "budget_empenhado_bloqueado_teto"` — e era isso que o `toast.error` mostrava:
 * nome de tabela, nome de constraint e nada sobre o que fazer. O banco é a
 * ÚLTIMA linha de defesa (a primeira é a validação no handler); quando ela
 * dispara, a mensagem ainda precisa ser legível.
 *
 * Traduzir não substitui validar: uma constraint que dispara com frequência é
 * validação faltando no handler, e a frase genérica daqui é o sintoma disso.
 */

/** Forma do erro do `pg` que interessa aqui. */
type PgError = {
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  detail?: string;
};

/**
 * Constraints cuja violação tem explicação específica. Sem entrada aqui, a
 * mensagem cai no genérico por código — legível, mas sem o "por quê".
 */
const POR_CONSTRAINT: Record<string, string> = {
  budget_empenhado_bloqueado_teto:
    "A dotação não comporta o valor: empenhado mais contingenciado não pode passar do orçado. Libere o contingenciamento ou aumente a dotação.",
  budget_bloqueado_nonneg:
    "O contingenciamento não pode ficar negativo: a liberação excede o que está bloqueado.",
  payroll_cycles_totals_check:
    "Os totais da folha não fecham: líquido tem de ser proventos menos descontos.",
  payroll_cycle_results_values_check:
    "O resultado do servidor não fecha: líquido tem de ser proventos menos descontos.",
  payroll_cycles_reopen_reason_check:
    "A reabertura da folha exige justificativa com pelo menos 10 caracteres.",
  tax_pago_teto:
    "O valor pago ultrapassaria o lançado neste crédito tributário.",
  restos_exercicio_check: "O exercício de origem do resto a pagar é inválido.",
  restos_tipo_check:
    "Tipo de resto a pagar inválido: use processado ou não processado.",
};

/** Mensagem por código SQLSTATE, quando a constraint não tem texto próprio. */
function porCodigo(erro: PgError): string | null {
  switch (erro.code) {
    case "23505": // unique_violation
      return "Já existe um registro com estes dados. Verifique os campos que identificam o registro.";
    case "23503": // foreign_key_violation
      return erro.detail?.includes("is still referenced")
        ? "Este registro não pode ser excluído porque outros registros dependem dele."
        : "O registro referenciado não existe ou é de outra entidade.";
    case "23502": // not_null_violation
      return `Campo obrigatório não preenchido${erro.column ? `: ${erro.column.replace(/_/g, " ")}` : ""}.`;
    case "23514": // check_violation
      return "Os valores informados violam uma regra de consistência do registro.";
    case "22P02": // invalid_text_representation
      return "Valor em formato inválido para o tipo do campo.";
    case "22003": // numeric_value_out_of_range
      return "Valor numérico fora da faixa permitida.";
    case "22001": // string_data_right_truncation
      return "Texto maior que o limite do campo.";
    case "40P01": // deadlock_detected
      return "Outra operação alterou os mesmos registros ao mesmo tempo. Tente novamente.";
    case "40001": // serialization_failure
      return "Conflito de concorrência ao gravar. Tente novamente.";
    case "57014": // query_canceled
      return "A operação demorou demais e foi cancelada.";
    case "P0001": // raise_exception — as triggers do projeto já escrevem em PT
      return null;
    default:
      return null;
  }
}

/** True quando o objeto veio do driver `pg` (tem SQLSTATE de 5 caracteres). */
function ehErroDoPostgres(e: unknown): e is PgError & Error {
  return (
    e instanceof Error &&
    typeof (e as PgError).code === "string" &&
    /^[0-9A-Z]{5}$/.test((e as PgError).code as string)
  );
}

/**
 * Devolve o erro como está, ou um `Error` com a frase traduzida. As exceções
 * levantadas por `raise exception` nas triggers do projeto já estão em
 * português e passam intactas.
 */
export function traduzirErroDoBanco(e: unknown): unknown {
  if (!ehErroDoPostgres(e)) return e;
  const especifica = e.constraint ? POR_CONSTRAINT[e.constraint] : undefined;
  const mensagem = especifica ?? porCodigo(e);
  if (!mensagem) return e;
  const traduzido = new Error(mensagem);
  // Preserva o original para o log do servidor; o usuário vê só a frase.
  (traduzido as Error & { cause?: unknown }).cause = e;
  return traduzido;
}
