-- O0-10 (Incremento 1) — Materializar a ponte legada de permissoes como papel real.
--
-- Ate aqui, loadTenantAccess unia permissoes a partir das tabelas globais
-- user_roles/rh_permissions (a "ponte"). O caso grave: um admin legado recebia o
-- catalogo inteiro em TODO tenant do qual e membro (escalacao entre entes).
-- Removida a ponte, o admin legitimo nao perde nada (ja e tenant_admin, que tem
-- o catalogo). Mas o RH legado recebia, pela ponte, 47 permissoes (o catalogo
-- exceto tenant.manage/security.manage/audit.read) que o papel RBAC mapeado
-- (sector_manager) nao carrega. Esta migration cria um papel real que carrega
-- exatamente essas 47, para que desligar a ponte preserve o acesso efetivo do RH.
--
-- Aditiva e idempotente. Nao apaga papeis legados; nao faz backfill de admin (isso
-- reproduziria a escalacao que O0-10 remove). Ver ADR 0014 e src/lib/tenant-access.server.ts.

begin;

-- Papel de transicao por entidade que materializa o RH legado.
insert into public.security_roles (tenant_id, codigo, nome, descricao, system_role)
select t.id, 'rh_operador', 'Operador de RH (legado)',
       'Papel de transicao que materializa as permissoes do RH legado (O0-10)', true
from public.tenants t
on conflict do nothing;

-- Concede a rh_operador as 47 permissoes da uniao da ponte: o catalogo inteiro
-- exceto as tres que o RH legado nunca teve. Forma a prova de drift: acompanha o
-- catalogo automaticamente se novas permissoes surgirem.
insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on p.codigo not in ('tenant.manage', 'security.manage', 'audit.read')
where r.codigo = 'rh_operador'
on conflict do nothing;

-- Rede de seguranca idempotente: reafirma que tenant_admin tem o catalogo inteiro.
-- Assim, desligar a uniao legacyAdmin nao reduz nenhum administrador real.
insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on true
where r.codigo = 'tenant_admin'
on conflict do nothing;

-- Backfill: todo usuario com papel legado 'rh' e associacao ativa recebe
-- rh_operador no tenant correspondente. Espelha o backfill unico da Sprint 1 e
-- fecha o drift dos usuarios criados depois dela. Sem backfill de admin.
insert into public.security_user_roles (tenant_id, user_id, role_id, valid_from)
select tm.tenant_id, tm.user_id, sr.id, current_date
from public.tenant_memberships tm
join public.security_roles sr on sr.tenant_id = tm.tenant_id and sr.codigo = 'rh_operador'
where tm.status = 'ativo'
  and exists (select 1 from public.user_roles ur where ur.user_id = tm.user_id and ur.role::text = 'rh')
on conflict do nothing;

commit;
