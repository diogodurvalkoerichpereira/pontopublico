# Entrega da Sprint 2 — isolamento, escopos, auditoria e vínculos

Data: 16/08/2026  
Escopo: HU01.04–HU01.06, HU02.03–HU02.05 e HU03.01–HU03.03.

## Resultado implementado

- isolamento por tenant e por unidade para os novos dados funcionais;
- escopo global, local ou com descendentes por atribuição de papel;
- papéis com vigência, revogação sem exclusão e histórico consultável;
- auditoria por tenant com operador, data, recurso, registro e JSON antes/depois;
- cadastro global de pessoa com deduplicação por CPF;
- múltiplas matrículas por pessoa, inclusive em entidades diferentes;
- dados do vínculo: tipo, regime, cargo, função, jornada, lotação, centro de custo, salário-base, admissão, desligamento e status;
- migração dos perfis legados para `persons` e `employment_links`;
- validação de lotação no mesmo tenant, matrícula única por entidade e campos mínimos para ativação;
- permissões `people.read`, `people.manage` e `people.sensitive.read`;
- telas `/rh/pessoas` e `/admin/auditoria`;
- tela `/admin/seguranca` ampliada para vigência, revogação e escopos.

## Banco de dados

Aplicar, nessa ordem, somente em homologação:

1. `supabase/migrations/20260816150000_sprint1_multi_tenant_security.sql`;
2. `supabase/migrations/20260816190000_sprint2_people_scopes_audit.sql`;
3. executar `scripts/reconcile-sprint2.sql` e arquivar o resultado.

Antes da aplicação: backup lógico, janela de homologação e cópia das contagens de `profiles`, `unidades` e memberships. O projeto Supabase de produção não foi alterado nesta entrega.

## Evidências automatizadas

Comandos executados localmente:

```bash
node scripts/validate-sprint1-migration.mjs
node scripts/validate-sprint2-migration.mjs
npm run build
```

O teste da Sprint 2 valida:

- deduplicação de CPF;
- 100% dos perfis legados associados a uma pessoa;
- inclusão e exclusão de descendentes conforme o escopo;
- RLS ocultando vínculo fora do escopo e liberando descendente autorizado;
- bloqueio de matrícula duplicada;
- bloqueio de lotação pertencente a outro tenant;
- bloqueio de vínculo ativo sem campos obrigatórios.

## Gate manual de homologação

- criar dois tenants com dados equivalentes e confirmar que um usuário não vê o outro;
- configurar gestor com escopo local e depois com descendentes;
- expirar e revogar uma atribuição, confirmando negação sem apagar o histórico;
- cadastrar o mesmo CPF com uma segunda matrícula e confirmar reutilização da pessoa;
- abrir o evento em Auditoria e comparar antes/depois;
- executar a reconciliação e exigir zero inconsistências antes de promover.
