# ADR 0004 — Separar `profiles`/`persons`/`employment_links` em vez de fundir

Status: aceito.

## Contexto

Duas gerações de identidade coexistem: `profiles` (legado, 1:1 com login) e
`persons` + `employment_links` (novo). A tentação é fundir tudo em `persons`.

## Decisão

Não fundir. Declarar três papéis distintos e documentá-los:

- `profiles` = **identidade de login** (quem autentica).
- `persons` = **registro civil** (quem a pessoa é).
- `employment_links` = **o vínculo** (o contrato de trabalho).

Ligar por `persons.identity_profile_id` quando necessário, sem colapsar as
tabelas.

> **Correção (O0-13).** O elo real construído é o inverso:
> **`profiles.person_id → persons.id`** (adicionado na Sprint 2). A coluna
> `persons.identity_profile_id` nunca existiu no esquema. A decisão de **separar**
> permanece; só o nome do elo aqui estava errado. `employment_links` aponta para
> ambas: `person_id → persons.id` e `source_profile_id → profiles.id` (elo legado).

## Consequências

- As três respondem a perguntas diferentes; misturá-las confunde login com
  cadastro civil.
- Evita cascata por todo o esquema de segurança.

## Por quê

`profiles` é referenciada por `app_users`, `security_user_roles.user_id`,
`audit_events.actor_id`, `tenant_memberships.user_id` e
`payroll_cycles.prepared_by`. Fundir identidade em `persons` propagaria a mudança
por toda a segurança e a auditoria — risco desproporcional ao ganho.

## Alternativa descartada

Fundir em `persons` — cascata de migração por todo o esquema de segurança.
