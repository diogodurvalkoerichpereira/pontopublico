-- O4-08 (Onda 4 — Tributação) — Certidão de Dívida Ativa (CDA, Lei 6.830 art. 2º).
-- Depois de inscrito em dívida ativa, o crédito recebe uma CDA numerada por ente e
-- exercício, que fixa o saldo inscrito (título executivo). Aqui é o REGISTRO da CDA
-- (número + valor inscrito + fundamento) — NÃO emite documento autenticado, código de
-- validação nem assinatura (isso depende de homologação/ferramenta do ente). Reusa
-- taxes.*. Uma CDA por crédito.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.active_debt_certificate_counters (
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  last_numero bigint not null default 0,
  primary key (tenant_id, exercicio)
);

create table if not exists public.active_debt_certificates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  exercicio integer not null,
  numero bigint not null,
  credit_id uuid not null references public.tax_credits(id) on delete restrict,
  valor_inscrito numeric(16,2) not null,
  data_inscricao date not null,
  fundamento_legal text not null default 'Lei 6.830, art. 2o',
  status text not null default 'ativa',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint cda_status_check check (status in ('ativa', 'cancelada', 'quitada')),
  constraint cda_valor_pos check (valor_inscrito > 0),
  unique (tenant_id, exercicio, numero),
  unique (tenant_id, credit_id)
);

create index if not exists active_debt_certificates_credit_idx
  on public.active_debt_certificates (credit_id);

-- Coerência de ente: o crédito certificado é da mesma entidade.
create or replace function public.validate_active_debt_certificate() returns trigger language plpgsql set search_path=public as $$
declare ct uuid;
begin
  select tenant_id into ct from public.tax_credits where id=new.credit_id;
  if ct is null or ct<>new.tenant_id then
    raise exception 'CDA de credito de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_active_debt_certificate before insert or update on public.active_debt_certificates
  for each row execute function public.validate_active_debt_certificate();

alter table public.active_debt_certificates enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy cda_read on public.active_debt_certificates for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.read'));
    create policy cda_manage on public.active_debt_certificates for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'taxes.manage'))
      with check (private.has_tenant_permission(tenant_id, 'taxes.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.active_debt_certificates to authenticated;
  end if;
end
$$;

commit;
