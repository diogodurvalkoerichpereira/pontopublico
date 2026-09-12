-- O3-08b (Onda 3 — Contratações) — Propostas e julgamento por menor preço (Lei 14.133
-- art. 33-34). Cada licitação recebe propostas de fornecedores com o valor proposto; o
-- julgamento por menor preço classifica as propostas válidas e a de menor valor vence.
-- Uma proposta pode ser desclassificada (com motivo) e então não concorre. Reusa
-- contracts.*. Uma proposta por fornecedor/licitação.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.procurement_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  process_id uuid not null references public.procurement_processes(id) on delete cascade,
  fornecedor text not null,
  fornecedor_documento text not null,
  valor_proposto numeric(16,2) not null,
  desclassificada boolean not null default false,
  motivo_desclassificacao text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint proposal_valor_pos check (valor_proposto > 0),
  constraint proposal_fornecedor_not_blank check (btrim(fornecedor) <> ''),
  constraint proposal_motivo_when_desclass check (
    not desclassificada or btrim(coalesce(motivo_desclassificacao, '')) <> ''
  ),
  unique (process_id, fornecedor_documento)
);

create index if not exists procurement_proposals_process_idx
  on public.procurement_proposals (process_id);

-- Coerência de ente: a proposta é da mesma entidade da licitação.
create or replace function public.validate_procurement_proposal() returns trigger language plpgsql set search_path=public as $$
declare pt uuid;
begin
  select tenant_id into pt from public.procurement_processes where id = new.process_id;
  if pt is null or pt <> new.tenant_id then
    raise exception 'Proposta de licitacao de outra entidade';
  end if;
  return new;
end $$;

create trigger trg_validate_procurement_proposal before insert or update on public.procurement_proposals
  for each row execute function public.validate_procurement_proposal();

alter table public.procurement_proposals enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy procurement_proposals_read on public.procurement_proposals for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.read'));
    create policy procurement_proposals_manage on public.procurement_proposals for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'contracts.manage'))
      with check (private.has_tenant_permission(tenant_id, 'contracts.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.procurement_proposals to authenticated;
  end if;
end
$$;

commit;
