# ADR 0011 — Reusar o workflow de `payroll_cycles` como motor de documentos

Status: aceito.

## Contexto

O núcleo SIAFIC (Onda 2) precisa de documentos com ciclo de vida controlado:
empenho (`rascunho→emitido→anulado`), liquidação, ordem bancária. `payroll_cycles`
já resolveu, com qualidade, o mesmo problema para a folha.

## Decisão

Extrair de `src/lib/payroll-cycle.functions.ts` um motor genérico
(`document-workflow.server.ts`) com as quatro propriedades já provadas:

1. máquina de estados declarativa (o `transitionRules` generaliza);
2. lock otimista (`expected_version` + `FOR UPDATE`);
3. segregação de funções (quem prepara ≠ quem aprova ≠ quem paga);
4. evento imutável com checksum.

## Consequências

- Empenho, liquidação e OB viram ~30 linhas de declaração cada, sobre um motor
  auditado, em vez de reimplementação.
- O mesmo padrão de trilha vale para folha e contabilidade.

## Por quê

Reusar um padrão já testado em produção é mais barato e mais seguro que
reinventá-lo por documento. A folha antecipou, sem querer, o motor do SIAFIC.

## Alternativa descartada

Modelar cada documento contábil do zero — retrabalho e risco de divergência de
comportamento entre documentos.
