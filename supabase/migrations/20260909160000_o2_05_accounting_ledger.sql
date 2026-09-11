-- O2-05 (Onda 2 — núcleo SIAFIC) — Razão contábil em partidas dobradas. O coração
-- do PCASP: todo fato contábil (empenho, liquidação, pagamento, arrecadação...)
-- gera um lançamento com linhas de débito e crédito que se igualam. Aqui o razão
-- é genérico e balanceado por construção (a server function recusa lançamento
-- desbalanceado); os roteiros de contabilização automática vêm nos próximos
-- incrementos. Ver ADR 0001 e ROADMAP_GESTAO_PUBLICA.md.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

insert into public.security_permissions (codigo, modulo, nome, criticidade)
values
  ('accounting.read', 'contabilidade', 'Consultar lançamentos contábeis', 'sensivel'),
  ('accounting.manage', 'contabilidade', 'Escriturar lançamentos contábeis', 'critica')
on conflict (codigo) do update set nome = excluded.nome;

insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on p.codigo in ('accounting.read', 'accounting.manage')
where r.codigo = 'tenant_admin'
on conflict do nothing;

create table if not exists public.accounting_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  data_lancamento date not null,
  historico text not null,
  source text not null default 'manual',
  source_ref uuid,
  valor numeric(16,2) not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint accounting_entry_exercicio_check check (exercicio between 2000 and 2200),
  constraint accounting_entry_historico_not_blank check (btrim(historico) <> ''),
  constraint accounting_entry_valor_pos check (valor > 0)
);

create table if not exists public.accounting_entry_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  entry_id uuid not null references public.accounting_entries(id) on delete cascade,
  conta text not null,
  lado char(1) not null,
  valor numeric(16,2) not null,
  constraint accounting_line_conta_check check (conta ~ '^[0-9.]{1,30}$'),
  constraint accounting_line_lado_check check (lado in ('D', 'C')),
  constraint accounting_line_valor_pos check (valor > 0)
);

create index if not exists accounting_entries_exercicio_idx
  on public.accounting_entries (tenant_id, exercicio, data_lancamento);

create index if not exists accounting_entry_lines_entry_idx
  on public.accounting_entry_lines (entry_id);

create index if not exists accounting_entry_lines_conta_idx
  on public.accounting_entry_lines (tenant_id, conta);

-- Coerência de ente: a linha é do mesmo ente do cabeçalho.
create or replace function public.validate_accounting_line() returns trigger language plpgsql set search_path=public as $$
declare et uuid;
begin
  select tenant_id into et from public.accounting_entries where id=new.entry_id;
  if et is null or et<>new.tenant_id then
    raise exception 'Linha contabil de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_accounting_line before insert or update on public.accounting_entry_lines
  for each row execute function public.validate_accounting_line();

alter table public.accounting_entries enable row level security;
alter table public.accounting_entry_lines enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy accounting_entry_read on public.accounting_entries for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.read'));
    create policy accounting_entry_manage on public.accounting_entries for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.manage'))
      with check (private.has_tenant_permission(tenant_id, 'accounting.manage'));
    create policy accounting_line_read on public.accounting_entry_lines for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.read'));
    create policy accounting_line_manage on public.accounting_entry_lines for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'accounting.manage'))
      with check (private.has_tenant_permission(tenant_id, 'accounting.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.accounting_entries to authenticated;
    grant select, insert, update on public.accounting_entry_lines to authenticated;
  end if;
end
$$;

commit;
