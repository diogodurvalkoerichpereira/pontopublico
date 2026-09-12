# Entrega da Sprint 6 — folhas especiais

Data: 17/08/2026  
Escopo do roadmap: EP06 / F06–F10 — adiantamento, complementar e 13º salário.

## Resultado implementado

- adiantamento parametrizado por percentual do salário-base;
- compensação automática do adiantamento fechado na prévia mensal da mesma competência;
- unicidade da compensação para impedir desconto em duplicidade;
- folha complementar vinculada à folha mensal fechada;
- ajustes complementares por vínculo, natureza, valor e justificativa, sem alterar a folha original;
- 13º em primeira e segunda parcelas;
- avos pelo critério de ao menos 15 dias trabalhados no mês;
- base por último salário ou média das folhas mensais fechadas no ano;
- fallback explícito para salário-base quando ainda não existe histórico para média;
- segunda parcela condicionada ao fechamento da primeira para todos os vínculos;
- INSS progressivo, IRRF e compensação da primeira parcela na segunda;
- snapshot das faixas tributárias, método, base, avos, operações e checksum por vínculo;
- uso do mesmo fluxo maker-checker da Sprint 5 para conferência, aprovação e fechamento;
- RLS, permissões específicas e validação de referências entre entidades.

## Interface

- `/rh/folhas-especiais` — criação, cálculo, memória, conferência, aprovação e fechamento;
- adiantamento com percentual e seleção de vínculos;
- complementar com seleção da folha original e múltiplos ajustes;
- 13º com seleção de método e vínculos.

## Homologação

Aplicar `20260817143000_sprint6_special_payrolls.sql` após a Sprint 5 e executar `scripts/reconcile-sprint6.sql`. O projeto de produção não foi alterado.

## Evidências

```bash
npm run test:sprint6:special
npm run build
```

O teste cobre avos, corte de 15 dias, duas parcelas, origem da complementar, isolamento entre entidades, compensação única do adiantamento e presença do gancho na folha mensal.

## Gate manual

- fechar adiantamento de 40% e confirmar o desconto na prévia mensal;
- reabrir a mensal, gerar nova prévia e confirmar que a compensação não duplicou;
- fechar uma mensal, criar complementar e conferir que a original não mudou;
- calcular 13º por último salário e por média, confrontando a memória;
- validar admissão com 14 e 15 dias no mês;
- fechar a primeira parcela e conferir INSS, IRRF e compensação na segunda;
- atualizar as faixas tributárias vigentes e homologá-las com especialista de folha;
- executar a reconciliação e exigir zero inconsistências.

## Limite consciente

As faixas legais são lidas de `payroll_config` e congeladas no snapshot. Antes de uso real, a assessoria de folha deve validar tabelas, regimes próprios, afastamentos que alteram avos e regras locais da entidade. A implementação entrega o motor e a rastreabilidade, mas não substitui essa homologação normativa.
