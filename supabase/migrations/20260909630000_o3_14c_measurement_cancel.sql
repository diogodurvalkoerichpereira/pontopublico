-- O3-14c — Cancelamento (glosa/rejeicao) de medicao provisoria de contrato.
--
-- A medicao provisoria (O3-14) e o registro da entrega; o recebimento definitivo
-- (O3-14b) e o atesto que autoriza o pagamento. Faltava desfazer uma medicao
-- provisoria rejeitada na verificacao (Lei 14.133 art. 140) — devolvendo o valor
-- ao saldo executavel do contrato. Esta migration amplia o estado da medicao com
-- 'cancelado' (terminal); o recebimento definitivo continua sendo terminal e nao
-- cancela. Aditiva: o default e a semantica das medicoes existentes nao mudam.
--
-- Legivel, uma instrucao por linha.

begin;

alter table public.contract_measurements
  drop constraint if exists contract_measurement_recebimento_check;

alter table public.contract_measurements
  add constraint contract_measurement_recebimento_check
  check (recebimento in ('provisorio', 'definitivo', 'cancelado'));

commit;
