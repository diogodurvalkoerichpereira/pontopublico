-- Sprint 19: ajuda contextual, conversa de suporte e SLA.
insert into public.security_permissions(codigo,nome,modulo) values('support.use','Usar suporte contextual','support') on conflict(codigo) do nothing;
insert into public.security_role_permissions(role_id,permission_id) select r.id,p.id from public.security_roles r join public.security_permissions p on p.codigo='support.use' where r.codigo in('tenant_admin','sector_manager','auditor') on conflict do nothing;
create table if not exists public.support_articles(
 id uuid primary key default gen_random_uuid(),tenant_id uuid references public.tenants(id) on delete cascade,slug text not null,title text not null,content text not null,route_pattern text,tags text[] not null default '{}',published boolean not null default true,updated_at timestamptz not null default now(),unique(tenant_id,slug)
);
create table if not exists public.support_conversations(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.tenants(id) on delete cascade,user_id uuid not null references public.profiles(id),subject text not null,status text not null default 'open' check(status in('open','waiting','resolved')),route_context text,created_at timestamptz not null default now(),resolved_at timestamptz
);
create table if not exists public.support_messages(
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.support_conversations(id) on delete cascade,sender_id uuid not null references public.profiles(id),body text not null check(char_length(body) between 1 and 4000),created_at timestamptz not null default now()
);
alter table public.support_articles enable row level security;alter table public.support_conversations enable row level security;alter table public.support_messages enable row level security;
create policy support_articles_read on public.support_articles for select to authenticated using(published and (tenant_id is null or private.is_tenant_member(tenant_id)));
create policy support_conversation_owner on public.support_conversations for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()) and private.is_tenant_member(tenant_id));
create policy support_message_participant on public.support_messages for all to authenticated using(exists(select 1 from public.support_conversations c where c.id=conversation_id and c.user_id=(select auth.uid()))) with check(sender_id=(select auth.uid()) and exists(select 1 from public.support_conversations c where c.id=conversation_id and c.user_id=(select auth.uid())));
revoke all on public.support_articles,public.support_conversations,public.support_messages from anon;grant select on public.support_articles to authenticated;grant select,insert,update on public.support_conversations to authenticated;grant select,insert on public.support_messages to authenticated;
insert into public.support_articles(tenant_id,slug,title,content,route_pattern,tags) values
(null,'trocar-entidade','Como trocar a entidade ativa','Use o seletor no topo da tela. Seus dados e permissões são recalculados para a entidade escolhida.','/',['entidade','acesso']),
(null,'reconciliar-data-mart','Como reconciliar o data mart','Abra Administração > Data mart e execute Atualizar e reconciliar. Divergências devem ser investigadas antes de usar os painéis.','/admin/data-mart',['data mart','reconciliação']),
(null,'entender-lrf','Como interpretar o painel LRF','O painel usa uma janela móvel de até 12 meses e parâmetros auditáveis. Confira os valores com o controle interno.','/gestor/lrf',['lrf','rcl'])
on conflict(tenant_id,slug) do nothing;
