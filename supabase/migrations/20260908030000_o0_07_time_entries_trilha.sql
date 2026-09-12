-- O0-07 — Ponto com valor probatorio.
--
-- Acrescenta trilha de alteracao e exclusao logica a time_entries, e remove a
-- capacidade de exclusao fisica. A partir daqui, criacao/edicao/exclusao de
-- batida pelo RH passa pelas server functions de src/lib/timesheet.functions.ts,
-- que validam o ente e gravam audit_events. O funcionario continua batendo o
-- proprio ponto pelo shim (com user_id forcado ao proprio usuario).

alter table public.time_entries add column if not exists updated_at timestamptz;
alter table public.time_entries add column if not exists updated_by uuid;
alter table public.time_entries add column if not exists deleted_at timestamptz;
alter table public.time_entries add column if not exists deleted_by uuid;
alter table public.time_entries add column if not exists delete_reason text;

-- Exclusao fisica deixa de existir como conceito, mesmo quando a RLS for
-- ativada (Onda 2). Correcao de batida e soft-delete com motivo e trilha.
drop policy if exists "te_rh_delete" on public.time_entries;

-- Leituras vivas (apuracao de folha, VT/VA, espelho) so consideram batidas nao
-- excluidas; o indice parcial acompanha esse filtro.
create index if not exists idx_time_entries_user_date_live
  on public.time_entries (user_id, entry_at desc)
  where deleted_at is null;
