-- O5-02 (Onda 5 — Transparência) — Permissão de leitura do portal da transparência.
-- Sem tabelas novas: o relatório agrega dados que já existem (execução da despesa,
-- receita, contratos). Só a permissão de acesso consolidado (Lei 12.527/LAI).
--
-- Aditiva. Legível, uma instrução por linha.

begin;

insert into public.security_permissions (codigo, modulo, nome, criticidade)
values ('transparency.read', 'transparencia', 'Consultar portal da transparencia', 'sensivel')
on conflict (codigo) do update set nome = excluded.nome;

insert into public.security_role_permissions (role_id, permission_id)
select r.id, p.id
from public.security_roles r
join public.security_permissions p on p.codigo = 'transparency.read'
where r.codigo = 'tenant_admin'
on conflict do nothing;

commit;
