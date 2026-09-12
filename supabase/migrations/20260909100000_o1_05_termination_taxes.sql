begin;

-- O1-05 — rescisao com INSS/IRRF sobre as verbas tributaveis.
-- O liquido da rescisao deixava de reter INSS/IRRF (net = total - descontos
-- manuais). Passa a reter pelo motor fiscal versionado (ADR 0003): INSS
-- progressivo + IRRF por faixa sobre o saldo de salario (competencia final) e
-- sobre o 13o proporcional (tributacao exclusiva). Colunas proprias para o termo
-- ser auditavel: o TCE le a base de cada tributo, nao um total agregado.

alter table public.termination_calculations
  add column if not exists inss_amount numeric(14,2) not null default 0;

alter table public.termination_calculations
  add column if not exists irrf_amount numeric(14,2) not null default 0;

commit;
