# ADR 0005 — Congelar `payroll_periods` em vez de migrar

Status: aceito.

## Contexto

Há duas folhas: `payroll_periods` (legado, grão usuário/mês com horas) e
`payroll_cycles` + `payroll_cycle_results` (novo, grão competência com resultado
por vínculo). Ambas aparecem no menu, sem indicar qual vale.

## Decisão

Não migrar uma na outra. **Congelar** `payroll_periods`: copiar o histórico para
`historical_records` (tabela que já existe para isso) e **remover `/rh/folha` do
menu**. A folha nova (`/rh/ciclos`) é a única válida.

## Consequências

- Uma folha só no produto; a demonstração de PoC deixa de ter resposta ambígua.
- O histórico é preservado como leitura, não como sistema ativo.

## Por quê

Os grãos são incompatíveis; converter um no outro **inventaria dados** que não
existem. E duas telas de folha no menu inviabilizam uma prova de conceito: o
avaliador pergunta qual vale, e a resposta honesta destrói a credibilidade.

## Alternativa descartada

Migrar `payroll_periods` para o modelo de `payroll_cycles` — fabricaria dados
inexistentes (resultado por vínculo a partir de horas por usuário).
