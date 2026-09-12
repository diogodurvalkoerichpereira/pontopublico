# ADR 0007 — Catraca de qualidade em vez de gate zero-erros

Status: aceito.

## Contexto

O repositório entra em CI com 274 erros de TypeScript e ~2022 de ESLint, herdados
das Sprints 12-20. Exigir zero desde já deixaria o pipeline permanentemente
vermelho.

## Decisão

`scripts/quality-ratchet.mjs` fixa o número atual como **teto** em
`quality-baseline.json` e falha se ele **subir**. Ao reduzir erros, roda-se
`npm run quality:update` e commita-se o baseline.

## Consequências

- O débito herdado fica visível e para de crescer.
- Cada correção baixa o teto de forma permanente.
- Código novo não pode introduzir erro de tipo ou lint.

## Por quê

Pipeline sempre vermelho não é gate — é ruído que se aprende a ignorar. A catraca
converte um débito grande demais para pagar de uma vez num limite que só desce.

## Alternativas descartadas

- **Gate zero-erros** — vermelho permanente, ignorado no dia dois.
- **Sem gate de qualidade** — o débito continua crescendo, foi como se chegou a 2022.
