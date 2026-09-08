# ADR 0002 — Adiar RLS real; consolidar a autorização aplicacional

Status: aceito.

## Contexto

O banco tem policies de RLS bem escritas, mas **inertes**: a aplicação conecta
como dono das tabelas e nunca faz `SET ROLE`/`set_config`, então a RLS não é
aplicada. A autorização real é 100% na aplicação (`loadTenantAccess` +
`requireTenantPermission`), e é fail-open por omissão.

## Decisão

**Não** ativar RLS agora. Consolidar a autorização aplicacional (guard
`withTenant`, teste de cobertura, pool com role não-dono) e adotar **RLS real
apenas no núcleo SIAFIC (Onda 2)**, onde não há chamador legado.

## Consequências

- Onda 0 fecha o risco sem a maior refatoração possível do código.
- As tabelas do SIAFIC nascem com RLS escrita contra `current_setting('app.tenant_id')`.
- As tabelas legadas só ganham RLS quando forem aposentadas.

## Por quê

`db.server.ts` expõe `query()` no nível de módulo sobre um pool. `SET ROLE`/
`set_config` são escopados à sessão do client; para valerem, seria preciso
reescrever as ~110 server functions para receberem um client. Risco altíssimo,
zero funcionalidade nova. E as policies atuais dependem de `auth.uid()` lendo um
claim JWT (herança do Supabase) — fazê-las valer exigiria reescrevê-las.

## Alternativa descartada

Ativar RLS já, com `SET ROLE` por requisição — reescrita massiva de todos os
handlers, sem ganho visível, com alto risco de app fail-closed demais (policies
negando tudo se um `set_config` faltar).
