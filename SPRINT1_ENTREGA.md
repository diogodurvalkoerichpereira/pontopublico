# Etapa 3 — Sprint 1: multi-entidade e segurança

Implementação inicial dos épicos EP01 e EP02 sobre o projeto **Meu Ponto**. A entrega foi preparada na branch local `feature/sprint-1-multi-tenant` e **não foi aplicada em produção**.

## Escopo implementado

- Entidades (`tenants`) e associação de usuários (`tenant_memberships`).
- Contexto de entidade ativa persistido no navegador e validado no servidor.
- Evolução aditiva de `unidades` para árvore organizacional, com código por entidade, tipo, hierarquia, ordenação e inativação.
- Bloqueio de unidade-pai de outra entidade e de ciclos na árvore.
- Catálogo de permissões, papéis por entidade, atribuições com vigência e escopo por unidade.
- Papéis iniciais: administrador da entidade, gestor setorial, auditor e servidor.
- Migração dos usuários e unidades legadas para uma entidade inicial, sem remover tabelas antigas.
- Auditoria de alterações de estrutura, papéis e atribuições.
- RLS e `GRANT` explícitos para instalações Supabase; o papel `anon` não recebe acesso.
- Autorização equivalente no backend PostgreSQL próprio do projeto.
- Tela `/admin/estrutura` para entidades e árvore organizacional.
- Tela `/admin/seguranca` para matriz de permissões e atribuição de papéis.
- Seletor de entidade ativa no cabeçalho.
- Novos usuários passam a ser associados à entidade ativa e recebem um papel inicial.

## Arquivos centrais

- `supabase/migrations/20260816150000_sprint1_multi_tenant_security.sql`
- `src/lib/tenant-access.server.ts`
- `src/lib/organization.functions.ts`
- `src/lib/auth-context.tsx`
- `src/routes/admin.estrutura.tsx`
- `src/routes/admin.seguranca.tsx`
- `scripts/validate-sprint1-migration.mjs`

## Validação executada

```bash
npm ci
npm run test:sprint1:migration
npm run build
```

O teste da migração sobe um PostgreSQL compatível em memória, cria uma amostra do esquema legado, aplica a migração e verifica:

- migração de entidade, associação, unidade e papel legado;
- criação do catálogo e dos papéis iniciais;
- bloqueio de ciclo organizacional;
- bloqueio de atribuição de papel sem associação ativa à entidade.

O lint dos oito arquivos criados ou alterados para a Sprint 1 foi executado sem erros. Permanece um aviso legado de Fast Refresh no `auth-context.tsx`.

## Aplicação segura em homologação

1. Gerar backup restaurável do banco atual.
2. Restaurar uma cópia anonimizada em homologação.
3. Confirmar que a homologação contém `profiles`, `user_roles`, `rh_permissions`, `unidades` e `set_updated_at()`.
4. Revisar o projeto/URL de destino antes de executar qualquer comando.
5. Aplicar somente a migração da Sprint 1 pelo pipeline de migrações utilizado no ambiente.
6. Executar a reconciliação abaixo antes de liberar as telas:
   - todo perfil possui exatamente uma associação padrão ativa;
   - toda unidade possui `tenant_id` e `codigo`;
   - administradores legados receberam `tenant_admin`;
   - usuários RH receberam `sector_manager`;
   - demais usuários receberam `employee`.
7. Testar dois usuários em entidades distintas e confirmar ausência de vazamento cruzado.
8. Somente após o aceite, planejar a aplicação em produção com janela e rollback.

## Limites desta entrega

- A migração ainda não foi executada no banco do usuário.
- Não foi possível consultar o projeto Supabase indicado em `supabase/config.toml`, pois ele não está disponível na conexão Supabase ativa desta sessão.
- O repositório já possuía avisos de APIs depreciadas do TanStack e erros globais de tipagem no shim legado; eles não impedem o build de produção e não fazem parte da Sprint 1.
- Escopos por unidade estão modelados no banco, mas a interface detalhada para configurar descendentes fica para a Sprint 2.
