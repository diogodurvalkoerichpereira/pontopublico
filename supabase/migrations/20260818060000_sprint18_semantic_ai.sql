-- Sprint 18: assistente analítico com camada semântica e painéis salvos.
insert into public.security_permissions(codigo,nome,modulo) values('ai.analytics.use','Usar assistente analítico','analytics') on conflict(codigo) do nothing;
insert into public.security_role_permissions(role_id,permission_id) select r.id,p.id from public.security_roles r join public.security_permissions p on p.codigo='ai.analytics.use' where r.codigo in('tenant_admin','sector_manager','auditor') on conflict do nothing;
create table if not exists public.ai_conversations(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete cascade,user_id uuid not null references public.profiles(id) on delete cascade,title text not null default 'Nova análise',created_at timestamptz not null default now()
);
create table if not exists public.ai_messages(
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.ai_conversations(id) on delete cascade,role text not null check(role in('user','assistant')),content text not null,metric_code text,evidence jsonb not null default '{}',created_at timestamptz not null default now()
);
create table if not exists public.ai_saved_panels(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete cascade,user_id uuid not null references public.profiles(id) on delete cascade,title text not null,metric_code text not null,filters jsonb not null default '{}',created_at timestamptz not null default now()
);
alter table public.ai_conversations enable row level security;alter table public.ai_messages enable row level security;alter table public.ai_saved_panels enable row level security;
create policy ai_conversation_owner on public.ai_conversations for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()) and private.is_tenant_member(tenant_id));
create policy ai_message_owner on public.ai_messages for all to authenticated using(exists(select 1 from public.ai_conversations c where c.id=conversation_id and c.user_id=(select auth.uid()))) with check(exists(select 1 from public.ai_conversations c where c.id=conversation_id and c.user_id=(select auth.uid())));
create policy ai_panel_owner on public.ai_saved_panels for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()) and private.is_tenant_member(tenant_id));
revoke all on public.ai_conversations,public.ai_messages,public.ai_saved_panels from anon;grant select,insert,update,delete on public.ai_conversations,public.ai_messages,public.ai_saved_panels to authenticated;
