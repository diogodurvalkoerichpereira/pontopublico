# ADR 0001 — SIAFIC como âncora; base de dados única

Status: aceito.

## Contexto

A evolução para ERP público poderia ser modelada como módulos independentes
(orçamento, contabilidade, tesouraria, folha…) integráveis por API. É como se
pensa software corporativo.

## Decisão

O núcleo é um **SIAFIC**: orçamento, contabilidade e tesouraria compartilham
**uma base de dados única**, com ponto único de entrada, e os demais domínios
(folha, compras, tributação) alimentam esse núcleo via empenho e receita
arrecadada — não são sistemas separados que conversam.

## Consequências

- O núcleo SIAFIC é o centro do roadmap; sem ele não há ERP público, só
  acessórios.
- A folha precisa emitir empenho cedo (Onda 1) para o modelo nascer certo.
- Vende-se em bloco, não por módulo avulso.

## Por quê (não é escolha técnica)

O Decreto 10.540/2020 **obriga** base única e integrada para execução
orçamentária, financeira e contábil, compartilhada entre Executivo, Legislativo e
RPPS. Orçamento, contabilidade e tesouraria de fornecedores diferentes são
ilegais. Modelar como módulos integráveis produziria um sistema que não pode ser
vendido a um ente.

## Alternativa descartada

Módulos independentes com integração por API — inviável juridicamente.
