# ADR 0003 — Tabelas fiscais com nó `table_lookup`, não condicionais na AST

Status: aceito.

## Contexto

INSS, IRRF e RPPS são tabelas progressivas por faixa. O motor de fórmulas
(`src/lib/payroll-formula.ts`) é seguro justamente porque **não** tem
condicionais nem comparadores: 3 tipos de nó, 4 operadores, whitelist de 11
variáveis, sem `eval`. Uma faixa progressiva é impossível de escrever nele hoje.

## Decisão

Tabelas fiscais viram **entidade de primeira classe** (`fiscal_tables` +
`fiscal_table_versions`, versionadas por vigência e por ente), e a AST ganha
**exatamente um** nó novo, declarativo:
`{type:"table_lookup", table:"INSS_FEDERAL", mode:"progressive", base:<ast>}`.

## Consequências

- O motor continua fechado (sem `if`, sem operadores novos); os dados ficam
  abertos e versionados.
- `table` é um **código**, não dados: a AST nunca contém alíquota. As tabelas
  chegam pré-carregadas como `Map`, igual às variáveis — o avaliador continua
  função pura, sem I/O.
- O id e o checksum da versão de tabela entram na memória de cálculo — o número
  fica defensável perante o TCE.
- RPPS vira configuração por ente, não código: atende N municípios sem deploy.

## Alternativas descartadas

- **`if` na AST** — destrói a propriedade que torna o motor seguro.
- **Flag `calculation_kind='inss'` com código hardcoded** — funciona para INSS/
  IRRF federais e quebra no RPPS, porque cada ente tem alíquotas em lei própria;
  cada município viraria um deploy.
