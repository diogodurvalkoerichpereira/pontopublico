# Registros de Decisão de Arquitetura (ADR)

Uma decisão por arquivo. Cada uma foi tomada por um motivo que não é óbvio no
código — e que uma sessão futura reverteria sem saber. Antes de contrariar
qualquer uma, leia o ADR e, se ainda fizer sentido contrariar, escreva um novo
ADR que a substitua (não apague o antigo).

Formato: contexto · decisão · consequências · alternativas descartadas.

| #                                        | Decisão                                                           | Status |
| ---------------------------------------- | ----------------------------------------------------------------- | ------ |
| [0001](0001-siafic-ancora.md)            | SIAFIC como âncora; base de dados única                           | aceito |
| [0002](0002-adiar-rls-real.md)           | Adiar RLS real; consolidar autorização aplicacional               | aceito |
| [0003](0003-table-lookup.md)             | Tabelas fiscais com nó `table_lookup`, não condicionais na AST    | aceito |
| [0004](0004-separar-profiles-persons.md) | Separar `profiles`/`persons`/`employment_links` em vez de fundir  | aceito |
| [0005](0005-congelar-payroll-periods.md) | Congelar `payroll_periods` em vez de migrar                       | aceito |
| [0006](0006-conformidade-artefatos.md)   | Política de conformidade de artefatos de saída                    | aceito |
| [0007](0007-catraca-qualidade.md)        | Catraca de qualidade em vez de gate zero-erros                    | aceito |
| [0008](0008-migrations-imutaveis.md)     | Migrations imutáveis após aplicadas                               | aceito |
| [0009](0009-um-tce-por-vez.md)           | Um layout de TCE por vez, por oportunidade                        | aceito |
| [0010](0010-esocial-nao-atendido.md)     | eSocial pode ser declarado não atendido                           | aceito |
| [0011](0011-workflow-como-motor.md)      | Reusar o workflow de `payroll_cycles` como motor de documentos    | aceito |
| [0012](0012-manter-shim-supabase.md)     | Manter o shim Supabase deliberadamente                            | aceito |
| [0013](0013-mfa-alto-risco.md)           | MFA (TOTP) restrito a operações de alto risco, uma vez por sessão | aceito |
| [0014](0014-aposentar-ponte-legada.md)   | Aposentar a ponte legada de permissões (reconciliação + flag)     | aceito |
| [0015](0015-auditoria-central.md)        | Escrita de auditoria por um único helper                          | aceito |
