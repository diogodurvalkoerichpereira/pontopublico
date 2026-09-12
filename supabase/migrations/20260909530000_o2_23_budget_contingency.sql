-- O2-23 (Onda 2 — núcleo SIAFIC) — Contingenciamento / limitação de empenho (LRF art. 9).
-- Quando a arrecadação frustra as metas, o ente bloqueia parte de uma dotação, reduzindo
-- o saldo empenhável sem alterar o valor orçado. O bloqueio nunca invade o já empenhado
-- (empenhado + bloqueado ≤ orçado). Reusa budget.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

alter table public.budget_appropriations add column if not exists valor_bloqueado numeric(16,2) not null default 0;

alter table public.budget_appropriations drop constraint if exists budget_bloqueado_nonneg;
alter table public.budget_appropriations add constraint budget_bloqueado_nonneg check (valor_bloqueado >= 0);

alter table public.budget_appropriations drop constraint if exists budget_empenhado_bloqueado_teto;
alter table public.budget_appropriations add constraint budget_empenhado_bloqueado_teto check (valor_empenhado + valor_bloqueado <= valor_orcado);

commit;
