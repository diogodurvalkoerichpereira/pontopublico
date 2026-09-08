# ADR 0016 — Testes de comportamento em PGlite no lugar dos validadores de grep

Status: aceito (Incremento 1).

## Contexto

As Sprints 8-20 nunca ganharam teste de verdade: cada
`scripts/validate-sprintN.mjs` lia o `.sql`/`.ts` como **string** e afirmava com
`String.includes()`. Um teste assim passa mesmo com o SQL quebrado — foi como a
Sprint 19 passou verde com erro de sintaxe e a 13 com coluna inexistente. Pior,
esses validadores eram scripts órfãos: **não rodavam no CI nem no `npm test`**. O
CLAUDE.md é explícito — "teste que lê arquivo como string não é teste".

## Decisão

Substituir os validadores por testes `node:test` que **executam** o esquema e o
código:

- **`tests/helpers/pglite.mjs`** — `createTestDb()` sobe o esquema real
  (bootstrap + migrations) numa PGlite em memória, aplicando um arquivo por `exec`
  (nunca uma transação só — há arquivos com `begin;` próprio e um `ALTER TYPE …
ADD VALUE`). `migrationFiles()` é a **fonte única** da lista/ordem; o gate
  `scripts/db-dryrun.mjs` passou a importá-la, para gate e testes não divergirem.
- Cada teste convertido afere **comportamento**: constraints e triggers reais
  (inserir dado inválido e esperar o erro documentado), valores computados, e —
  para os módulos de saída — `conformanceOf` em runtime e o esquema
  (`information_schema`). A guarda de honestidade sobre a fonte (rótulos que não
  podem se apresentar como padrão oficial) permanece como uma **rede de lint**,
  complementando, não substituindo, a rede de comportamento (doutrina das "duas
  redes").

Feito por incrementos: o Incremento 1 entrega o helper e converte as Sprints 8,
10, 11, 12; os demais seguem a mesma receita.

## Consequências

- Os checks convertidos agora rodam no `npm test` e, portanto, no CI (antes,
  órfãos). Cada um **falha** se a migration ou o código regride — verificado por
  mutação, o que o grep antigo nunca fez.
- A PGlite (`@electric-sql/pglite`, já devDependency) dá um Postgres 17 em memória
  sem Docker; os testes de banco rodam no mesmo lugar que os de unidade.
- `db-dryrun` e os testes compartilham a descoberta de arquivos — não há duas
  listas para manter em sincronia.

## Alternativas descartadas

- **Manter os validadores de grep** — o problema que esta decisão resolve;
  passavam com SQL quebrado e não rodavam no CI.
- **Exigir Postgres real (Docker) nos testes** — o CI já tem um job `banco-real`
  para as migrations; para o comportamento, PGlite em memória é suficiente e roda
  em qualquer lugar, inclusive no `npm test` local.
- **Converter tudo num único PR** — 13-14 sprints de uma vez é grande e arriscado;
  o helper + um lote representativo estabelece o padrão com segurança.
