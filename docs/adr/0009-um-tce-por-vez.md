# ADR 0009 — Um layout de TCE por vez, por oportunidade concreta

Status: aceito.

## Contexto

Cada Tribunal de Contas estadual tem seu layout de prestação de contas (SICOM/MG,
AUDESP/SP, SIM-AM/PR, e-Contas/CE…). Suportar vários é multiplicar o custo de
conformidade.

## Decisão

Implementar **um** layout de TCE por vez, disparado por oportunidade concreta —
nunca especulativamente. O motor de exportação é declarativo (descritores de
campo interpretados por um writer posicional), de modo que somar um layout é
dado, não código novo.

## Consequências

- O custo de conformidade cresce por demanda real, não por antecipação.
- Erro de alvo corrigido: a referência de Timóteo é **SICOM/TCE-MG**, não TCE-CE
  (o código tinha rótulo TCE-CE). Os arquivos do SICOM são majoritariamente
  contábeis, logo só implementáveis após a Onda 2.

## Alternativa descartada

Suportar vários TCEs desde já — multiplica o esforço de conformidade sem cliente
que o justifique.
