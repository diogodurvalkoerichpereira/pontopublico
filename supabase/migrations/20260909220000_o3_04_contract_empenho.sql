-- O3-04 (Onda 3 — Materiais e Contratações) — Contrato → orçamento. O contrato
-- administrativo (O3-01) passa a poder virar empenho real contra dotação (O2-02),
-- pelo mesmo primitivo `reserveOnAppropriation` já usado pela folha (O2-04).
-- Amplia o CHECK de origem do empenho para aceitar 'contrato'.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

alter table public.budget_commitments
  drop constraint if exists budget_commitment_source_check;

alter table public.budget_commitments
  add constraint budget_commitment_source_check
  check (source in ('manual', 'folha', 'contrato'));

commit;
