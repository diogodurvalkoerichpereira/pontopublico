-- O3-11c (Onda 3 — Patrimonio) — Eventos contabeis da baixa/alienacao de bem.
-- A baixa passa a contabilizar pelo roteiro configuravel do ente
-- (accounting_event_accounts, O2-06), em tres eventos de duas linhas:
--   baixa_bem_depreciacao     D depreciacao acumulada  / C imobilizado   (dep. acumulada)
--   baixa_bem_desincorporacao D VPD desincorporacao     / C imobilizado   (valor liquido)
--   baixa_bem_alienacao       D disponibilidade         / C VPA alienacao (valor alienado)
-- O resultado da baixa (VPA − VPD) fecha com `resultado_baixa` do bem. Sem
-- mapeamento, a baixa segue sem contabilizar (comportamento do O2-06).
--
-- O check de event_code e texto (nao enum): recria-se na mesma transacao.
-- Aditiva. Legivel, uma instrucao por linha.

begin;

alter table public.accounting_event_accounts
  drop constraint if exists accounting_event_code_check;

alter table public.accounting_event_accounts
  add constraint accounting_event_code_check
  check (event_code in ('empenho', 'empenho_anulacao', 'liquidacao', 'pagamento', 'baixa_bem_depreciacao', 'baixa_bem_desincorporacao', 'baixa_bem_alienacao'));

commit;
