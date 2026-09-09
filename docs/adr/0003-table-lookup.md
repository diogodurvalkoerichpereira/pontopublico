# ADR 0003 — Tabelas fiscais com nó `table_lookup`, não condicionais na AST

Status: aceito · implementado em O1-01.

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

## Nota de implementação (O1-01)

Schema concreto em `supabase/migrations/20260908060000_o1_01_fiscal_tables.sql`:

- **`fiscal_tables`** — `code` (`^[A-Z0-9_]+$`), `name`, `status`, `tenant_id`
  **nullable**. Unicidade por `(coalesce(tenant_id, '000…'::uuid), lower(code))`.
- **`fiscal_table_versions`** — `version_number`, `valid_from`/`valid_to`,
  `status` (`rascunho`|`publicada`|`arquivada`), `brackets jsonb`, `checksum`
  (CHECK 64-hex). Trigger `validate_fiscal_table_version`: coerência de ente
  (`is distinct from`, tratando o ente nulo como valor legítimo) e
  não-sobreposição de vigências **publicadas** por `daterange && daterange`
  (espelha `payroll_rubric_versions`).

Convenções e mecânica:

- **`tenant_id` nulo = tabela NACIONAL** (INSS/IRRF federais, iguais para todo
  ente); `tenant_id` preenchido = tabela do ente (RPPS, O1-02). O loader
  (`src/lib/fiscal-tables.server.ts`) resolve por código + vigência preferindo o
  do ente à nacional (`order by v.tenant_id nulls last`, primeira por código
  vence).
- **Dois modos.** `progressive` (INSS): soma `(min(base,ate)-prev)*aliquota` por
  faixa, o topo da última é o teto. `bracket` (IRRF): faixa onde `base<=ate`,
  retorna `base*aliquota - deduzir` (nunca negativo).
- **Checksum das faixas** = sha256 do JSON canônico (`stableFiscalBracketsJson`,
  faixas ordenadas por `ate`, chaves alfabéticas). Pré-computado no seed (sem
  pgcrypto) e **reconferido** pelo loader — divergência lança, para o número não
  sair de uma tabela adulterada. O `versionId`+`checksum` entram no passo
  `table_lookup` da memória de cálculo.
- O avaliador (`evaluateFormulaAst(input, variables, tables, scale, mode)`) recebe
  as tabelas como 3º parâmetro — um segundo `Map` pré-carregado ao lado das
  variáveis; permanece **sem I/O**.

**Feito em O1-01b:** o 13º (`payroll-special.functions.ts`) foi repontado de
`payroll_config` para `loadFiscalTables`; a matemática de faixa unificou-se em
`progressiveLookup`/`bracketLookup` (fonte única) e `payroll_config` foi congelada
in-place (ADR 0017). A rescisão (`employment-special.functions.ts`) nunca usou
`payroll_config`.

**Feito em O1-02a:** `fiscal-tables.functions.ts` deu o write-path governado das
tabelas do ente (`fiscal.manage`, auditado, publicada imutável, checksum
reconferido pelo loader). Só o ente é gerido pela app — as nacionais seguem por
migration.

**Feito em O1-02b/O1-02c:** o regime virou entidade (`pension_regimes` +
`employment_links.pension_regime_id`, O1-02b) e as rubricas de contribuição são
declaradas por regime (`pension_regime_rubrics`, O1-02c). O ciclo aplica-as
automaticamente a todo vínculo do regime (merge com as atribuições por vínculo,
que têm precedência) — sem tocar o avaliador puro: só a camada de seleção de
rubricas. Assim uma rubrica RPPS com `table_lookup` contra a tabela do ente
calcula-se para todos os estatutários, com o id+checksum da versão na memória.
