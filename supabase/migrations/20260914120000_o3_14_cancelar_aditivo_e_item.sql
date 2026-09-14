-- O3-14 — Desfazer aditivo e item de contrato.
--
-- Aditivo e item eram operacoes de mao unica: uma vez registrados, nao havia como
-- corrigi-los. Isso e material porque os dois consomem cota legal — o aditivo
-- consome o limite de 25% do valor original (Lei 14.133 art. 125) e o item consome
-- o valor total do contrato. Um lancamento errado queimava a cota para sempre, e o
-- caminho de "registrar outro compensando" nao existe: o limite e sobre o valor
-- ACUMULADO, entao o erro e o estorno somariam duas vezes contra o teto.
--
-- O cancelamento e logico (status), nunca exclusao: em contrato publico o historico
-- do que foi registrado e depois desfeito faz parte da instrucao do processo.
--
-- `vigencia_anterior` guarda a vigencia que o contrato tinha ANTES do aditivo de
-- prazo. Sem ela o cancelamento nao teria para onde voltar: a regra de negocio so
-- aceita prorrogar (nova vigencia > atual), entao a data anterior nao e recuperavel
-- por calculo.

begin;

alter table public.contract_amendments
  add column if not exists status text not null default 'vigente';

alter table public.contract_amendments
  add column if not exists vigencia_anterior date;

alter table public.contract_amendments
  add column if not exists cancelado_em timestamptz;

alter table public.contract_amendments
  add column if not exists cancelado_por uuid references public.profiles(id) on delete set null;

alter table public.contract_amendments
  add column if not exists motivo_cancelamento text;

alter table public.contract_amendments
  drop constraint if exists amendment_status_check;

alter table public.contract_amendments
  add constraint amendment_status_check check (status in ('vigente', 'cancelado'));

-- Cancelado exige motivo: sem ele o registro nao presta contas de si.
alter table public.contract_amendments
  drop constraint if exists amendment_cancelamento_motivo;

alter table public.contract_amendments
  add constraint amendment_cancelamento_motivo
  check (status <> 'cancelado' or btrim(coalesce(motivo_cancelamento, '')) <> '');

alter table public.contract_items
  add column if not exists status text not null default 'vigente';

alter table public.contract_items
  add column if not exists cancelado_em timestamptz;

alter table public.contract_items
  add column if not exists cancelado_por uuid references public.profiles(id) on delete set null;

alter table public.contract_items
  add column if not exists motivo_cancelamento text;

alter table public.contract_items
  drop constraint if exists contract_item_status_check;

alter table public.contract_items
  add constraint contract_item_status_check check (status in ('vigente', 'cancelado'));

alter table public.contract_items
  drop constraint if exists contract_item_cancelamento_motivo;

alter table public.contract_items
  add constraint contract_item_cancelamento_motivo
  check (status <> 'cancelado' or btrim(coalesce(motivo_cancelamento, '')) <> '');

create index if not exists contract_amendments_status_idx
  on public.contract_amendments (tenant_id, contract_id, status);

create index if not exists contract_items_status_idx
  on public.contract_items (tenant_id, contract_id, status);

commit;
