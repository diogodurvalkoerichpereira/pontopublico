# ADR 0006 — Política de conformidade de artefatos de saída

Status: aceito.

## Contexto

Três módulos geravam arquivos com nome de padrão oficial sem implementar o
padrão: `layout_version='CNAB240-v1'` produzindo 47 caracteres onde o CNAB 240
exige 240 posições; o mesmo CSV de 5 colunas para TCE-CE, SIOPE e MAND; e o
eSocial marcando eventos como `assinado` sem assinar.

## Decisão

Nenhum artefato leva o nome de um padrão oficial antes de aceite pelo sistema
oficial. Até lá:

- rótulos carregam o prefixo `RASCUNHO_`;
- `src/lib/conformance.ts` registra, por artefato, o status (`conforme` /
  `rascunho` / `nao-implementado`) e o que falta;
- operação que não pode ser executada honestamente **falha explicitamente**
  (`NotImplementedConformanceError`) em vez de gravar sucesso falso.

## Consequências

- Nem a interface nem uma declaração em licitação podem apresentar um rascunho
  como padrão oficial.
- Testes garantem que os rótulos não voltem a sugerir conformidade.

## Por quê

Em licitação, atesta-se o que o sistema faz. Um arquivo "CNAB240" que não é CNAB
240 é declaração falsa de conformidade em processo licitatório — risco que se
materializa **depois** da adjudicação, quando é pior.

## Alternativa descartada

Deixar como estava e "resolver depois" — mantém o risco jurídico latente e
convida à declaração falsa.
