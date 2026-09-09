-- O1-03d — Calendario de feriados por ente (base para o espelho, DSR, banco de
-- horas e apuracao da folha).
--
-- Feriado fixo recorre todo ano no mesmo dia (year NULL); feriado movel (Carnaval,
-- Sexta-feira Santa, Corpus Christi) ou ponto facultativo pontual leva um ano
-- especifico. tenant_id NULO = NACIONAL (fixos federais, semeados uma vez);
-- tenant_id preenchido = do ente (estadual/municipal/facultativo). Espelha a
-- convencao nacional/ente das tabelas fiscais (O1-01).
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.holidays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete restrict,
  name text not null,
  holiday_type text not null,
  year integer,
  month integer not null,
  day integer not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint holidays_name_not_blank check (btrim(name) <> ''),
  constraint holidays_type_check check (holiday_type in ('nacional', 'estadual', 'municipal', 'facultativo')),
  constraint holidays_month_check check (month between 1 and 12),
  constraint holidays_day_check check (day between 1 and 31),
  constraint holidays_year_check check (year is null or year between 1900 and 2200)
);

-- Unicidade por escopo (ente ou nacional) e data (ano/mes/dia; year nulo = todo ano).
create unique index if not exists holidays_scope_date_uq
  on public.holidays (
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(year, 0), month, day
  );

alter table public.holidays enable row level security;

-- Nacionais (tenant nulo) legiveis por todos; do ente por people.read; gestao do
-- ente por people.manage. Nacional nao e gerida pela app (vem por migration).
do $$
begin
  if to_regnamespace('auth') is not null then
    create policy holidays_read on public.holidays for select to authenticated
      using (tenant_id is null or private.has_tenant_permission(tenant_id, 'people.read'));
    create policy holidays_manage on public.holidays for all to authenticated
      using (tenant_id is not null and private.has_tenant_permission(tenant_id, 'people.manage'))
      with check (tenant_id is not null and private.has_tenant_permission(tenant_id, 'people.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on public.holidays to authenticated;
  end if;
end
$$;

-- Feriados nacionais fixos (Lei 662/1949, 6.802/1980 e 14.759/2023). Recorrentes
-- (year nulo). Moveis (Carnaval, Sexta-feira Santa, Corpus Christi) dependem da
-- Pascoa e sao cadastrados por ano pelo ente.
insert into public.holidays (tenant_id, name, holiday_type, month, day)
values
  (null, 'Confraternizacao Universal', 'nacional', 1, 1),
  (null, 'Tiradentes', 'nacional', 4, 21),
  (null, 'Dia do Trabalho', 'nacional', 5, 1),
  (null, 'Independencia do Brasil', 'nacional', 9, 7),
  (null, 'Nossa Senhora Aparecida', 'nacional', 10, 12),
  (null, 'Finados', 'nacional', 11, 2),
  (null, 'Proclamacao da Republica', 'nacional', 11, 15),
  (null, 'Dia Nacional de Zumbi e da Consciencia Negra', 'nacional', 11, 20),
  (null, 'Natal', 'nacional', 12, 25)
on conflict do nothing;

commit;
