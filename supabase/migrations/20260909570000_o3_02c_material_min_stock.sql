-- O3-02c (Onda 3 — Almoxarifado) — Estoque mínimo / ponto de pedido do material. Cada item
-- ganha um estoque mínimo (0 = sem controle); quando o saldo em estoque cai a esse nível ou
-- abaixo, o item entra no alerta de reposição. Aditiva, não recalcula saldo nenhum.
-- Legível, uma instrução por linha.

begin;

alter table public.material_items add column if not exists estoque_minimo numeric(16,3) not null default 0;

alter table public.material_items drop constraint if exists material_estoque_minimo_nonneg;

alter table public.material_items add constraint material_estoque_minimo_nonneg check (estoque_minimo >= 0);

commit;
