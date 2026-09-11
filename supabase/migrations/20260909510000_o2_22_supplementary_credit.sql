-- O2-22 (Onda 2 — núcleo SIAFIC) — Crédito adicional suplementar por EXCESSO DE
-- ARRECADAÇÃO (Lei 4.320, art. 43, II). Quando a receita arrecadada de uma fonte supera
-- a prevista, o excesso pode lastrear a suplementação de uma dotação. Aqui o crédito
-- suplementa o destino e é lastreado pelo excesso ainda não utilizado daquela fonte.
-- Reusa budget.*.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.budget_supplementary_credits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  destino_id uuid not null references public.budget_appropriations(id) on delete restrict,
  fonte_recurso text not null,
  valor numeric(16,2) not null,
  tipo text not null default 'excesso_arrecadacao',
  justificativa text not null,
  data_referencia date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint budget_supp_exercicio_check check (exercicio between 2000 and 2200),
  constraint budget_supp_valor_pos check (valor > 0),
  constraint budget_supp_tipo_check check (tipo in ('excesso_arrecadacao', 'superavit_financeiro')),
  constraint budget_supp_fonte_not_blank check (btrim(fonte_recurso) <> ''),
  constraint budget_supp_justificativa_not_blank check (btrim(justificativa) <> '')
);

create index if not exists budget_supplementary_credits_fonte_idx
  on public.budget_supplementary_credits (tenant_id, exercicio, fonte_recurso);

-- Coerência de ente: a dotação suplementada é da mesma entidade.
create or replace function public.validate_supplementary_credit() returns trigger language plpgsql set search_path=public as $$
declare dt uuid;
begin
  select tenant_id into dt from public.budget_appropriations where id=new.destino_id;
  if dt is null or dt<>new.tenant_id then
    raise exception 'Credito suplementar de dotacao de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_supplementary_credit before insert or update on public.budget_supplementary_credits
  for each row execute function public.validate_supplementary_credit();

alter table public.budget_supplementary_credits enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy budget_supp_read on public.budget_supplementary_credits for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.read'));
    create policy budget_supp_manage on public.budget_supplementary_credits for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'budget.manage'))
      with check (private.has_tenant_permission(tenant_id, 'budget.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.budget_supplementary_credits to authenticated;
  end if;
end
$$;

commit;
