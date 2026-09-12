-- O5-10 (Onda 5 — Integrações e alertas) — Integrações externas (chatbot menuia, bealys) e
-- canais de alerta (WhatsApp, e-mail) configuráveis por ente, com liga/desliga. A credencial
-- de cada integração é guardada no servidor e NUNCA devolvida ao cliente (a leitura só
-- informa se há credencial). O envio efetivo às plataformas externas depende de credencial e
-- endpoint reais (homologação externa) — aqui fica a configuração. Reusa org.read/org.manage.
--
-- Aditiva. Legível, uma instrução por linha.

begin;

create table if not exists public.integration_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  provider text not null,
  enabled boolean not null default false,
  base_url text,
  credential text,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  constraint integration_provider_check check (provider in ('menuia', 'bealys')),
  constraint integration_config_is_object check (jsonb_typeof(config) = 'object'),
  unique (tenant_id, provider)
);

create table if not exists public.alert_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  canal text not null,
  enabled boolean not null default false,
  destinatarios jsonb not null default '[]'::jsonb,
  eventos jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  constraint alert_canal_check check (canal in ('whatsapp', 'email')),
  constraint alert_destinatarios_is_array check (jsonb_typeof(destinatarios) = 'array'),
  constraint alert_eventos_is_array check (jsonb_typeof(eventos) = 'array'),
  unique (tenant_id, canal)
);

alter table public.integration_settings enable row level security;
alter table public.alert_settings enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy integration_settings_read on public.integration_settings for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'org.read'));
    create policy integration_settings_manage on public.integration_settings for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'org.manage'))
      with check (private.has_tenant_permission(tenant_id, 'org.manage'));
    create policy alert_settings_read on public.alert_settings for select to authenticated
      using (private.has_tenant_permission(tenant_id, 'org.read'));
    create policy alert_settings_manage on public.alert_settings for all to authenticated
      using (private.has_tenant_permission(tenant_id, 'org.manage'))
      with check (private.has_tenant_permission(tenant_id, 'org.manage'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.integration_settings to authenticated;
    grant select, insert, update on public.alert_settings to authenticated;
  end if;
end
$$;

commit;
