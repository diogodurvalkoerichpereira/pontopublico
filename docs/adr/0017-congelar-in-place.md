# ADR 0017 — Congelar `payroll_periods` in-place (refina ADR 0005)

Status: aceito. Refina o passo de cópia da [ADR 0005](0005-congelar-payroll-periods.md).

## Contexto

A ADR 0005 decidiu **congelar** `payroll_periods` e **remover `/rh/folha`**, e
descreveu o congelamento como "copiar o histórico para `historical_records`". Ao
implementar (O0-13), dois fatos apareceram:

- `historical_records` é **acoplado ao motor de jobs**: `job_id NOT NULL` referencia
  `historical_migration_jobs`. Copiar exigiria fabricar jobs (e um ator
  `created_by`) sintéticos.
- `payroll_periods` **não tem `tenant_id`** (grão usuário/mês, anterior ao
  multi-tenant). A cópia teria de resolver `user_id → tenant` linha a linha.
- Nenhuma migration semeia `payroll_periods`; num deploy novo a tabela está
  **vazia** — a cópia rodaria sobre zero linhas.

## Decisão

**Congelar in-place, não copiar.** Remover o caminho de escrita — a tela
`/rh/folha` e o registro de `payroll_periods` no shim (`pgrest.server.ts`) — deixa
a tabela como **arquivo read-only**: nenhum código da aplicação a alcança, e o
histórico existente (se houver) permanece legível direto no banco. Isso cumpre a
garantia de ADR 0005 ("o histórico é preservado como leitura, não como sistema
ativo") sem fabricar jobs/atores nem resolução cross-tenant frágil numa migration
que, na prática, rodaria vazia.

`payroll_config` **não** é congelada — é compartilhada com a folha nova
(`payroll-special.functions.ts`).

**Atualização (O1-01b):** `payroll_config` **também foi congelada in-place**, pelo
mesmo padrão. Depois que O1-01 entregou as tabelas fiscais versionadas
(`fiscal_tables`, ADR 0003), o único consumidor vivo — o 13º em
`payroll-special.functions.ts` — foi repontado para `loadFiscalTables`. Sem
consumidor, o singleton saiu do `TABLE_REGISTRY` e do `policyFor` do shim (sem
migration, sem DDL): vira arquivo read-only. A fonte fiscal viva passa a ser
`fiscal_tables`, versionada e com checksum na memória de cálculo. A trava é a
mesma de `payroll_periods`, coberta por `tests/folha-unica.test.mjs`.

## Consequências

- Uma folha só no produto (`/rh/ciclos`); o bloqueio de PoC de ADR 0005 é
  resolvido, sem migration nova nem risco no redeploy.
- `payroll_periods` fica fora do `TABLE_REGISTRY` do shim; `dbQuery` não a alcança
  — a trava do congelamento é na fronteira da aplicação, coberta por
  `tests/folha-unica.test.mjs` (verificado por mutação).
- A permissão legada `close_payroll` permanece (ainda bridada em `rh_operador`);
  aposentá-la é assunto da ponte legada (O0-10 Inc. 2/3).

## Alternativa descartada

Copiar para `historical_records` como a ADR 0005 dizia — fabricaria jobs e atores
sintéticos e resolução cross-tenant para dados que não existem no deploy. Se algum
dia houver dados legados a arquivar, o motor de migração histórica genérico já
existe para isso.
