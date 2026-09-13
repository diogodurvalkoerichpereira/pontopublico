-- O2-08c (Onda 2 — Receita) — Estorno de arrecadação. Uma arrecadação lançada por
-- engano (valor/data errados, duplicidade) precisa ser revertida sem apagar a trilha:
-- a linha permanece, marcada como estornada, e o valor_arrecadado da receita é
-- decrementado. Como revenue_collections.valor tem check > 0, não cabe linha negativa;
-- por isso o estorno é um flag na própria linha (append-only, auditável). Reusa budget.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

alter table public.revenue_collections add column if not exists estornada boolean not null default false;
alter table public.revenue_collections add column if not exists estornada_em timestamptz;
alter table public.revenue_collections add column if not exists estorno_motivo text;

commit;
