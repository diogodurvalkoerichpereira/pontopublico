# ADR 0008 — Migrations imutáveis após aplicadas

Status: aceito.

## Contexto

`scripts/db-migrate.mjs` mantém um ledger `schema_migrations` com checksum
SHA-256 por arquivo e aborta se um já aplicado mudar (escape: `--allow-checksum-drift`).

## Decisão

Migration aplicada é **imutável**. Qualquer correção de esquema é uma **migration
nova**. Migrations novas são legíveis (uma instrução por linha) e trazem `begin;`
próprio quando precisam de transação.

## Consequências

- O histórico de esquema é auditável e reproduzível.
- Editar uma migration existente quebra o ledger em toda instalação onde ela já
  rodou — por isso é proibido.
- As migrations minificadas das Sprints 12+ **não são reformatadas**: reformatar
  muda o checksum e quebra instalações. O lint impede apenas as novas de nascer
  minificadas.

## Por quê

Foi editar/minificar migrations que produziu os defeitos que o `db:dryrun` foi
criado para pegar (Sprint 19 com erro de sintaxe, Sprint 13 com coluna
inexistente). E `ALTER TYPE … ADD VALUE` mais o uso do valor precisam de
transações separadas — o migrator detecta `begin;` no arquivo e não o envelopa.

## Alternativa descartada

Permitir editar migrations e reformatar as antigas — quebra ledger e
reprodutibilidade.
