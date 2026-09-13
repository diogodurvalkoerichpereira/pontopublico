-- O4-14c (Onda 4 — Tributario) — Origem da arrecadacao tributaria. Cada pagamento
-- registra, no momento em que e feito, se o credito estava em cobranca corrente
-- ('corrente') ou inscrito em divida ativa ('divida_ativa'). Sem isso a receita
-- de divida ativa era irrecuperavel: o credito quitado perde o status de divida
-- ativa e nada mais dizia de onde veio o dinheiro — e os balancos nao a
-- consolidavam. Pagamentos anteriores a esta migration ficam 'corrente'
-- (classificacao desconhecida; documentado no BACKLOG).
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

alter table public.tax_payments
  add column if not exists origem text not null default 'corrente';

alter table public.tax_payments
  drop constraint if exists tax_payment_origem_check;

alter table public.tax_payments
  add constraint tax_payment_origem_check
  check (origem in ('corrente', 'divida_ativa'));

create index if not exists tax_payments_tenant_data_idx
  on public.tax_payments (tenant_id, data_pagamento);

commit;
