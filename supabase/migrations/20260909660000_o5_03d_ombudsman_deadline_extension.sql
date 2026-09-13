-- O5-03d (Onda 5 — Apoio e controle) — Ouvidoria: prorrogacao do prazo de
-- resposta (Lei 13.460/2017, art. 17). O prazo de resposta e prorrogavel de
-- forma justificada uma unica vez. Estas colunas registram se a manifestacao
-- ja foi prorrogada, quando e com qual justificativa, para que o painel possa
-- distinguir o prazo original do prorrogado e impedir a segunda prorrogacao.
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

alter table public.ombudsman_manifestations
  add column if not exists prazo_prorrogado boolean not null default false;

alter table public.ombudsman_manifestations
  add column if not exists prorrogado_em date;

alter table public.ombudsman_manifestations
  add column if not exists prorrogacao_justificativa text;

commit;
