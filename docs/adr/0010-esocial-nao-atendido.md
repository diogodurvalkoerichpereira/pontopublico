# ADR 0010 — eSocial pode ser declarado não atendido

Status: aceito.

## Contexto

O eSocial real exige XML validado por XSD por evento, assinatura XMLDSig com
certificado ICP-Brasil A1/A3, transmissão com polling de protocolo e ordenação de
eventos (S-1000 → S-1005 → S-2200 → S-1200 → S-1210). Custo: 3-6 meses, e A3 em
HSM exige hardware. É trabalho que não se faz solo.

## Decisão

Tratar o eSocial como candidato a **declarar não atendido** em edital, e gastar o
esforço equivalente em Contabilidade e Controle Interno, onde o custo por ponto é
uma ordem de grandeza menor. A implementação real fica em O1-06, condicionada a
disponibilidade.

## Consequências

- A matriz de conformidade marca eSocial 🔴 com honestidade.
- Como os editais-alvo vedam subcontratação, "atendido via terceiro" não é opção
  — declarar não atendido é a jogada honesta.

## Por quê

Fingir atendimento (o que o código fazia, marcando `assinado` sem assinar)
reprova a prova de conceito e expõe a declaração de conformidade. Melhor não
atender e dizê-lo.

## Alternativa descartada

Integração com fornecedor terceiro de eSocial — vedada pela cláusula de não
subcontratação dos editais de referência.
