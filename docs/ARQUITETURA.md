# Arquitetura

Complementa o [CLAUDE.md](../CLAUDE.md) (regras) com o desenho: como os pedaços
se encaixam e por que estão como estão.

## Stack

- **Frontend + backend num só app:** TanStack Start (React 19), servido por Nitro
  no preset `node-server`.
- **Banco:** PostgreSQL puro, acessado pelo driver `pg` — **não** há Supabase em
  runtime, apesar do nome de alguns diretórios.
- **Sem ORM:** SQL parametrizado (`$1`, `$2`) escrito à mão em cada função.

## Fluxo de uma requisição

```
Tela (src/routes/*.tsx)
  → useServerFn(minhaFn)                     server function via RPC
    → createServerFn.middleware([requireAuth])   valida sessão (JWT + auth_sessions)
    → .validator(zod)                            valida a entrada
    → .handler:
        loadTenantAccess(userId, tenant_id)      resolve papéis, permissões, escopo
        requireTenantPermission(access, "x")     autoriza — ou lança
        query("... where tenant_id = $1", [...]) SQL parametrizado
```

A autorização acontece **na aplicação**, não no banco. Ver
[ADR 0002](adr/0002-adiar-rls-real.md).

## Os dois caminhos de dados que coexistem

O projeto está em migração de uma geração para outra, e as duas convivem:

|             | Caminho legado                                              | Caminho atual                            |
| ----------- | ----------------------------------------------------------- | ---------------------------------------- |
| Entrada     | shim `@/integrations/supabase/client`                       | `createServerFn` em `*.functions.ts`     |
| Autorização | `policyFor()` em `pgrest.server.ts`, por papéis **globais** | `loadTenantAccess`, por tenant e unidade |
| Tabelas     | 13 legadas (`profiles`, `unidades`, `time_entries`…)        | todo o modelo novo                       |
| Problema    | **sem noção de tenant** — vaza entre entes                  | correto                                  |

O caminho legado está sendo aposentado (backlog O0-06 e O0-13). Enquanto existir,
trate-o como área de risco.

**Identidade e vínculo** (ADR 0004, glossário): `profiles` = login,
`persons` = registro civil, `employment_links` = vínculo (contrato numa
entidade). O caminho novo lê o civil de `persons` e o emprego de
`employment_links`, nunca de `profiles`. **Folha:** a válida é `payroll_cycles`
(`/rh/ciclos`); a legada `payroll_periods` foi congelada no O0-13 (ADR 0017). O
singleton fiscal `payroll_config` foi congelado no O1-01b — a fonte fiscal viva é
`fiscal_tables` (versionada, com checksum; ADR 0003).

### O shim Supabase — leia antes de "consertar"

`src/integrations/supabase/client.ts` **imita** o supabase-js (`.from().select()
.eq()`, `auth`, `storage`) mas roda sobre o PostgreSQL próprio via server
functions. No mesmo diretório:

- `client.server.ts` e `auth-middleware.ts` — **código morto** que lê
  `SUPABASE_*`. Ninguém os importa.
- `types.ts` — tipos gerados.

Quem "modernizar" isso importando `@supabase/supabase-js` de verdade quebra a
aplicação inteira. Manter o shim é decisão consciente — [ADR 0012](adr/0012-manter-shim-supabase.md).

## Modelo de dados por domínio

| Domínio                  | Tabelas centrais                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Multi-tenant / RBAC      | `tenants`, `tenant_memberships`, `security_permissions`, `security_roles`, `security_user_roles`, `security_user_unit_scopes` |
| Estrutura organizacional | `unidades` (árvore com anti-ciclo)                                                                                            |
| Pessoas e vínculos       | `persons`, `employment_links`, `person_dependents`, `pension_beneficiaries`                                                   |
| Folha                    | `payroll_rubrics` → `payroll_rubric_versions` (AST) → `payroll_cycles` → `payroll_cycle_results`                              |
| Tabelas fiscais          | `fiscal_tables` → `fiscal_table_versions` (INSS/IRRF/RPPS versionadas; `tenant_id` nulo = nacional) — nó `table_lookup`        |
| Ponto                    | `time_entries`, `work_schedules` (geração legada, fora do multi-tenant)                                                       |
| Auditoria                | `audit_events`                                                                                                                |
| Analítico                | schema `analytics`: `fact_payroll`, `fact_payroll_item`, `fact_movement`                                                      |

Duas gerações de identidade e de folha coexistem — `profiles` vs
`persons`/`employment_links`, `payroll_periods` vs `payroll_cycles`. A
unificação está em [ADR 0004](adr/0004-separar-profiles-persons.md) e no backlog.

## O motor de fórmulas

`src/lib/payroll-formula.ts` avalia uma AST em JSON — 4 tipos de nó, 4
operadores, whitelist de 11 variáveis, sem `eval`. É seguro **porque** não tem
condicionais. Tabelas progressivas (INSS/IRRF/RPPS) entram por um nó
`table_lookup` declarativo, não por `if` — [ADR 0003](adr/0003-table-lookup.md).
O `table` é código; as versões vigentes chegam pré-carregadas num `Map` por
`loadFiscalTables` (`fiscal-tables.server.ts`) e o avaliador continua **puro, sem
I/O** — o id + checksum da versão da tabela entram na memória de cálculo.

## Desenho-alvo: SIAFIC

O ERP público exige base de dados única para orçamento + contabilidade +
tesouraria (Decreto 10.540/2020). O núcleo contábil reusará o padrão de
`payroll_cycles` (máquina de estados + lock otimista + checksum) como motor de
documentos (empenho, liquidação, OB), e o lançamento contábil terá ponto único de
entrada. Detalhe em `ROADMAP_GESTAO_PUBLICA.md` e [ADR 0001](adr/0001-siafic-ancora.md).

## Migrations e deploy

- **Duas fases** (`scripts/db-migrate.mjs`): `db/bootstrap/**` reaplicado sempre
  (compat de PostgreSQL puro, idempotente) e `supabase/migrations/**` uma vez,
  registrado no ledger `schema_migrations` com checksum.
- **Imutabilidade:** migration aplicada não muda — [ADR 0008](adr/0008-migrations-imutaveis.md).
- **Deploy:** `Dockerfile` multi-stage; o runtime é o `.output` autossuficiente
  do Nitro mais um subconjunto de `pg` para o migrator. `tzdata` é obrigatório
  (fuso errado = erro de competência em folha).
