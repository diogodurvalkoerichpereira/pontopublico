-- O4-18 — Arrecadação passa a tocar o caixa e a contabilidade.
--
-- Receita e tributo arrecadados incrementavam `valor_arrecadado`/`valor_pago` e
-- NAO entravam em conta nenhuma: nenhum `treasury_movements`, nenhum lancamento
-- contabil. As consequencias eram todas visiveis e nenhuma era atribuida a esta
-- causa:
--   * o caixa ficava parado em zero enquanto os relatorios mostravam receita;
--   * toda ordem bancaria era recusada por saldo insuficiente, porque o dinheiro
--     arrecadado nunca chegou a conta;
--   * o `conciliado` da DFC era falso quase sempre, ja que o fluxo de entrada
--     nao existia como movimento.
--
-- Esta migration so acrescenta os codigos de evento contabil. O `event_code` e
-- texto com check (nao enum), entao o check e recriado com a lista completa — na
-- mesma transacao, como fez o O3-11c.
--
-- Os dois eventos novos:
--   arrecadacao          — ingresso de receita orcamentaria em conta de tesouraria
--   arrecadacao_estorno  — estorno da arrecadacao (devolucao/cancelamento)
--
-- Sem roteiro cadastrado para o codigo, `contabilizarEvento` devolve null e nada
-- e escriturado: o ente que ainda nao configurou o roteiro continua arrecadando,
-- so nao contabiliza. O movimento de tesouraria, esse, acontece sempre.

begin;

alter table public.accounting_event_accounts
  drop constraint if exists accounting_event_code_check;

alter table public.accounting_event_accounts
  add constraint accounting_event_code_check
  check (event_code in (
    'empenho',
    'empenho_anulacao',
    'liquidacao',
    'pagamento',
    'baixa_bem_depreciacao',
    'baixa_bem_desincorporacao',
    'baixa_bem_alienacao',
    'reavaliacao_positiva',
    'reavaliacao_negativa',
    'arrecadacao',
    'arrecadacao_estorno'
  ));

-- A conta que recebeu a arrecadacao. Nulo nos registros historicos, gravados
-- antes desta correcao: eles nao tocaram caixa nenhum e nao ha como adivinhar
-- qual conta teria sido. Obrigatorio dali em diante pela validacao no handler.
alter table public.revenue_collections
  add column if not exists account_id uuid references public.treasury_accounts(id) on delete restrict;

alter table public.tax_payments
  add column if not exists account_id uuid references public.treasury_accounts(id) on delete restrict;

create index if not exists revenue_collections_account_idx
  on public.revenue_collections (tenant_id, account_id);

create index if not exists tax_payments_account_idx
  on public.tax_payments (tenant_id, account_id);

commit;
