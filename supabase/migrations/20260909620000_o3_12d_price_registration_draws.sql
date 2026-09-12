-- O3-12d — Historico de consumos (adesoes/contratacoes) da ata de registro de precos.
--
-- Ate aqui `drawFromPriceRegistration` (O3-12) so incrementava
-- `quantidade_consumida` no item da ata — nao havia registro de CADA consumo
-- (quando, quanto, por quem, a que valor). Sem esse historico nao ha como auditar
-- ou demonstrar o uso da ata (accountability do SRP, Lei 14.133 art. 82-86). Esta
-- migration cria o razao dos consumos: uma linha por consumo, com valor
-- (quantidade x preco unitario do item registrado na ata).
--
-- Aditiva. Legivel, uma instrucao por linha.

begin;

create table if not exists public.price_registration_draws (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  registration_id uuid not null references public.price_registrations(id) on delete restrict,
  item_id uuid not null references public.price_registration_items(id) on delete restrict,
  quantidade numeric(16,3) not null,
  valor numeric(16,2) not null,
  data_referencia date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint price_draw_qtd_pos check (quantidade > 0),
  constraint price_draw_valor_nonneg check (valor >= 0)
);

create index if not exists price_registration_draws_item_idx
  on public.price_registration_draws (tenant_id, item_id, data_referencia);

-- Coerencia de ente: o item consumido e da mesma entidade do consumo.
create or replace function public.validate_price_registration_draw()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  item_tenant uuid;
begin
  select tenant_id into item_tenant from public.price_registration_items where id = new.item_id;
  if item_tenant is null or item_tenant <> new.tenant_id then
    raise exception 'Consumo de item de ata de outra entidade';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_price_registration_draw on public.price_registration_draws;
create trigger trg_validate_price_registration_draw
  before insert on public.price_registration_draws
  for each row execute function public.validate_price_registration_draw();

alter table public.price_registration_draws enable row level security;

-- Politicas so no ambiente Supabase (auth.*). Leitura por contracts.read, registro
-- por contracts.manage; sem update/delete (o razao nao se altera).
do $$
begin
  if to_regnamespace('auth') is not null then
    create policy price_draws_read on public.price_registration_draws for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.read'));
    create policy price_draws_insert on public.price_registration_draws for insert to authenticated
      with check (private.has_tenant_permission(tenant_id, 'contracts.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert on public.price_registration_draws to authenticated;
  end if;
end
$$;

commit;
