-- Sprint 15: PWA, inscrições push e fila transacional.
insert into public.security_permissions (codigo, nome, modulo)
values ('mobile.push.manage','Gerenciar notificações móveis','mobile')
on conflict (codigo) do nothing;
insert into public.security_role_permissions(role_id,permission_id) select r.id,p.id from public.security_roles r join public.security_permissions p on p.codigo='mobile.push.manage' where r.codigo='tenant_admin' on conflict do nothing;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, endpoint)
);
create table if not exists public.push_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 500),
  target_url text not null default '/',
  audience jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','cancelled')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.push_subscriptions enable row level security;
alter table public.push_notifications enable row level security;
create policy push_subscriptions_self on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (
    user_id = (select auth.uid()) and exists (
      select 1 from public.tenant_memberships m where m.tenant_id=push_subscriptions.tenant_id and m.user_id=(select auth.uid()) and m.status='ativo'
    )
  );
create policy push_notifications_tenant_read on public.push_notifications for select to authenticated
  using (exists (select 1 from public.tenant_memberships m where m.tenant_id=push_notifications.tenant_id and m.user_id=(select auth.uid()) and m.status='ativo'));
revoke all on public.push_subscriptions, public.push_notifications from anon;
grant select,insert,update,delete on public.push_subscriptions to authenticated;
grant select on public.push_notifications to authenticated;
