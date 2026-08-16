# Relatório consolidado de avanço após a Sprint 20

Data-base: 16/08/2026  
Fonte: backlog da Etapa 1, com 22 épicos e 102 pontos estimados.

## Avanço realizado

| Métrica                    | Concluído | Total | Percentual |
| -------------------------- | --------: | ----: | ---------: |
| Épicos com entrega técnica |        20 |    22 |  **90,9%** |
| Esforço ponderado          |        94 |   102 |  **92,2%** |
| Épicos P0                  |        17 |    19 |  **89,5%** |
| Esforço P0 ponderado       |        84 |    92 |  **91,3%** |

O indicador principal passou de **65,7% para 92,2%** de avanço técnico ponderado. Foram adicionados 27 pontos nas Sprints 15–20. Restam 2 épicos e 8 pontos.

## Sprints concluídas nesta rodada

15. PWA, preparação para lojas e Web Push;
16. data mart privado e reconciliado;
17. painel LRF/RCL e alertas parametrizáveis;
18. assistente com camada semântica, evidências e datasets;
19. ajuda contextual e conversa de suporte;
20. migração histórica com staging, janela de 15 anos e reconciliação.

## Validação executada

- validadores das Sprints 15–20 aprovados;
- build completo cliente e servidor aprovado;
- rotas novas geradas no bundle de produção;
- controles de tenant, permissões, RLS e revogação de `anon` revisados no código;
- nenhuma migração aplicada em produção.

Os validadores desta rodada verificam contratos e controles críticos. Como a CLI Supabase não estava instalada e nenhum banco de homologação foi autorizado, ainda é obrigatório aplicar as migrações em uma cópia anonimizada, testar RLS com usuários reais e reconciliar volumes/valores antes do aceite.

## Limites e dependências externas

- lojas Apple/Google: contas, certificados, ativos e revisão externa;
- Web Push: chaves VAPID e worker de expedição da fila;
- LRF/RCL: carga oficial e validação pelo controle interno; referência legal consultada na LC 101/2000;
- assistente: camada semântica determinística; um LLM generativo externo não foi conectado;
- suporte: exige operação humana e definição de SLA;
- migração histórica: requer arquivos reais, mapeamento por fonte e ensaio de performance.

## Sprints restantes

- EP21 — homologação regulatória e automação ampla (6 pontos);
- EP22 — ensaio, evidências e prova de conceito do edital (2 pontos).

O percentual mede execução do roadmap técnico. Não representa homologação jurídica, regulatória, operacional nem atendimento definitivo ao edital.
