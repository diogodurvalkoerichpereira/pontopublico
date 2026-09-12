-- O3-11 (Onda 3 — Patrimônio) — Baixa / alienação de bem patrimonial. Registra a
-- saída do bem do acervo (alienação, desfazimento, perda) e apura o resultado da
-- baixa = valor de alienação − valor líquido contábil (aquisição − depreciação
-- acumulada). Ganho quando positivo, perda quando negativo. Reusa assets.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

alter table public.patrimony_assets add column if not exists baixa_em date;
alter table public.patrimony_assets add column if not exists baixa_motivo text;
alter table public.patrimony_assets add column if not exists valor_alienacao numeric(16,2);
alter table public.patrimony_assets add column if not exists resultado_baixa numeric(16,2);
alter table public.patrimony_assets add column if not exists baixa_por uuid references public.profiles(id) on delete set null;

commit;
