-- O2-03 (Onda 2 — núcleo SIAFIC) — Liquidação e pagamento do empenho. Os estágios
-- da despesa após o empenho (Lei 4.320): liquidação (art. 63 — verificação do
-- direito adquirido do credor) e pagamento (art. 64). A anulação devolve o saldo
-- reservado à dotação. Marcos gravados por colunas de estágio; a transição é feita
-- pela server function (molde de transitionPayrollCycle). Ver ADR 0001.
--
-- Aditiva (colunas novas na tabela do O2-02). Legível, uma instrução por linha.

begin;

alter table public.budget_commitments
  add column if not exists liquidado_em timestamptz;

alter table public.budget_commitments
  add column if not exists liquidado_por uuid references public.profiles(id) on delete set null;

alter table public.budget_commitments
  add column if not exists pago_em timestamptz;

alter table public.budget_commitments
  add column if not exists pago_por uuid references public.profiles(id) on delete set null;

alter table public.budget_commitments
  add column if not exists anulado_em timestamptz;

alter table public.budget_commitments
  add column if not exists anulado_por uuid references public.profiles(id) on delete set null;

alter table public.budget_commitments
  add column if not exists anulado_motivo text;

commit;
