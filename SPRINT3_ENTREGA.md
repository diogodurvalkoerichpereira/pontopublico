# Entrega da Sprint 3 — família, movimentações e catálogo de folha

Data: 16/08/2026  
Escopo: HU03.04–HU03.06, HU04.01–HU04.02 e HU04.04.

## Resultado implementado

- dependentes ligados à pessoa titular, com vigência e efeitos de IR/previdência;
- reaproveitamento da pessoa existente quando o CPF do dependente já está cadastrado;
- pensionistas ligados ao vínculo funcional, por percentual ou valor fixo, com prioridade e vigência;
- bloqueio de percentual e valor fixo simultâneos e de rateio percentual superior a 100%;
- movimentações de admissão, lotação, afastamento, cessão, retorno e desligamento;
- preservação dos dados anterior/posterior, base legal e data de efeito;
- documentos de movimentação armazenados com hash SHA-256;
- movimentações atuais aplicadas ao vínculo e movimentações futuras mantidas como agendadas;
- catálogo de rubricas por tenant, com código, natureza, unidade e ordem de cálculo;
- versões independentes com vigência, publicação, arredondamento e preservação histórica;
- bloqueio de sobreposição entre versões publicadas;
- incidências de INSS, IRRF, FGTS e patronal;
- dependências entre rubricas com bloqueio de ciclos;
- projeção das bases a partir das incidências configuradas;
- RLS, concessões explícitas e auditoria das operações críticas.

## Novas telas

- `/rh/familia` — dependentes e pensionistas;
- `/rh/movimentacoes` — linha do tempo funcional e documentos;
- `/rh/rubricas` — catálogo, versões, bases e dependências.

## Aplicação em homologação

Aplicar na ordem:

1. `20260816150000_sprint1_multi_tenant_security.sql`;
2. `20260816190000_sprint2_people_scopes_audit.sql`;
3. `20260816193000_sprint3_family_movements_payroll_catalog.sql`;
4. executar `scripts/reconcile-sprint3.sql` e arquivar o resultado.

O projeto Supabase de produção não foi alterado.

## Evidências automatizadas

```bash
node scripts/validate-sprint1-migration.mjs
node scripts/validate-sprint2-migration.mjs
node scripts/validate-sprint3-migration.mjs
npm run build
```

O teste da Sprint 3 valida vigências, exclusividade e rateio da pensão, isolamento de movimentação, sobreposição de versões, ciclo de incidências, projeção da base previdenciária e RLS do catálogo.

## Gate manual de homologação

- cadastrar dependente com e sem efeito de IR e consultar por competência;
- cadastrar dois pensionistas e validar a ordem do rateio;
- anexar documento a uma movimentação e conferir caminho e SHA-256 na auditoria;
- agendar lotação futura e confirmar que o vínculo atual não é alterado antecipadamente;
- publicar nova versão futura e reproduzir a versão anterior;
- configurar rubrica compondo INSS e conferir a projeção da base;
- tentar fechar um ciclo entre rubricas e confirmar o bloqueio;
- executar a reconciliação e exigir zero inconsistências.
