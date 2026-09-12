# Entrega da Sprint 5 — ciclo mensal da folha

Data: 17/08/2026  
Escopo do roadmap: EP05 / F05 — prévia, conferência, aprovação, fechamento e reabertura.

## Resultado implementado

- materialização de uma simulação concluída como prévia oficial da competência;
- consolidação por vínculo de proventos, descontos, informativos e líquido;
- cópia imutável da memória de cálculo e checksum SHA-256 por resultado;
- fluxo controlado `prévia → conferência → aprovada → fechada`;
- reabertura somente com justificativa e geração obrigatória de nova versão;
- bloqueio de saltos de situação e de alterações em resultados fechados;
- controle de concorrência por versão e bloqueio transacional da competência;
- segregação de funções: o preparador não pode aprovar a mesma folha;
- trilha específica do ciclo e espelhamento no log geral de auditoria;
- permissões separadas para consulta, preparação, aprovação, fechamento e reabertura;
- RLS por entidade e concessões explícitas para as novas tabelas.

## Interface

- `/rh/ciclos` — competências, totais, conferência por vínculo, ações do fluxo e histórico;
- o menu **Ciclo mensal** só aparece para usuários com `payroll.cycles.read`.

## Homologação

Aplicar `20260817113000_sprint5_payroll_cycle.sql` depois das migrações das Sprints 1–4 e executar `scripts/reconcile-sprint5.sql`. O projeto de produção não foi alterado.

## Evidências

```bash
npm run test:sprint5:migration
npm run build
```

O teste automatizado cobre isolamento entre entidades, transições válidas, bloqueio de salto, imutabilidade após fechamento, justificativa de reabertura, incremento de versão, maker-checker e RLS.

## Gate manual

- gerar simulação para dois vínculos e materializar a prévia;
- conferir se os totais por vínculo reconciliam com a memória da simulação;
- enviar à conferência e tentar fechar sem aprovação (deve falhar);
- tentar aprovar com o mesmo usuário que preparou (deve falhar);
- aprovar com segundo usuário e fechar;
- tentar alterar/excluir resultado fechado (deve falhar);
- reabrir com justificativa e gerar nova prévia, confirmando a versão 2;
- executar a reconciliação e exigir zero inconsistências.
