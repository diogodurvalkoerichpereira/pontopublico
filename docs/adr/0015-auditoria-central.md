# ADR 0015 — Escrita de auditoria por um único helper

Status: aceito.

## Contexto

A trilha de auditoria (`public.audit_events`) era gravada por ~10 módulos, cada
um reimplementando o mesmo `insert` e o mesmo cálculo de metadados de requisição
(`request_id`, `ip`). Efeitos: colunas e serialização jsonb divergiam entre
módulos, e os módulos de **saída de dados** — remessa bancária, exportação
oficial, eSocial, migração histórica — não gravavam trilha **nenhuma**, apesar de
serem exatamente os atos que uma licitação exige rastrear (dados deixando o
sistema).

## Decisão

Centralizar a escrita em `src/lib/audit.server.ts`:

- `recordAudit(client, event)` — grava usando o `PoolClient` recebido, para que a
  trilha seja **atômica** com o ato auditado quando dentro de `withTransaction`.
- `recordAuditQ(event)` — grava direto no pool, para os atos fora de transação.
- Ambos preenchem `request_id`/`ip` a partir da requisição e serializam
  `before`/`after` como jsonb, de forma idêntica em toda a aplicação.

Todo `*.functions.ts` que grava auditoria passa a chamar o helper; **nenhum**
`insert into public.audit_events` cru permanece fora de `audit.server.ts`. Os
quatro módulos de saída de dados passam a registrar o ato.

## Consequências

- Uma rede de conformidade (`tests/audit-helper.test.mjs`) **falha o CI** se um
  módulo voltar a gravar auditoria com `insert` cru, e exige que os módulos de
  saída importem o helper — complementando o teste de comportamento que afere o
  SQL/params reais de `recordAudit`.
- Mudança futura no formato da trilha (nova coluna, novo metadado) é um ponto só.
- Os módulos de saída ganham rastreabilidade do que sai do sistema — requisito de
  auditoria em licitação.

## Alternativas descartadas

- **Deixar cada módulo com seu insert** — a divergência silenciosa entre módulos
  e a ausência de trilha nos atos de saída foi justamente o problema.
- **Trigger no banco** — a autorização e o contexto de requisição
  (`request_id`/`ip`, ator) são aplicacionais; um trigger não os conhece, e o
  projeto mantém a lógica na aplicação (ADR 0002).
