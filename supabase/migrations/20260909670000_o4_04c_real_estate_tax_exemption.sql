-- O4-04c (Onda 4 — Tributario) — Imunidade e isencao de IPTU no cadastro
-- imobiliario. Imovel imune (CF art. 150, VI: entes publicos, templos, partidos,
-- sindicatos, instituicoes de educacao/assistencia) ou isento (lei municipal:
-- aposentado de baixa renda, area de preservacao etc.) NAO recebe lancamento de
-- IPTU, avulso nem em lote. Sem estas colunas o lote de abertura do exercicio
-- lancava IPTU em imovel imune — lancamento indevido que depois exige cancelamento.
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

alter table public.real_estate_properties
  add column if not exists beneficio_iptu text;

alter table public.real_estate_properties
  add column if not exists beneficio_iptu_motivo text;

alter table public.real_estate_properties
  drop constraint if exists real_estate_beneficio_iptu_check;

alter table public.real_estate_properties
  add constraint real_estate_beneficio_iptu_check
  check (beneficio_iptu is null or beneficio_iptu in ('imunidade', 'isencao'));

alter table public.real_estate_properties
  drop constraint if exists real_estate_beneficio_motivo_check;

alter table public.real_estate_properties
  add constraint real_estate_beneficio_motivo_check
  check (beneficio_iptu is null or btrim(coalesce(beneficio_iptu_motivo, '')) <> '');

commit;
