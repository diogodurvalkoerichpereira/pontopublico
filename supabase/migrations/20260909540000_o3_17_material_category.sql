-- O3-17 (Onda 3 — Materiais) — Classificação do material (consumo/permanente) para
-- o inventário. Material de consumo baixa por VPD de consumo; material permanente,
-- quando adquirido, tende ao patrimônio. A classificação é o eixo do relatório de
-- inventário por categoria. Reusa material_items; default 'consumo' preserva o acervo.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

alter table public.material_items add column if not exists categoria text not null default 'consumo';

alter table public.material_items drop constraint if exists material_categoria_check;

alter table public.material_items add constraint material_categoria_check check (categoria in ('consumo', 'permanente'));

commit;
