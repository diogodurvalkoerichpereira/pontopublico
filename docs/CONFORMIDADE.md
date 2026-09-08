# Matriz de conformidade

O que o produto atende hoje, por bloco de requisito típico de pregão de software
público. Base para decidir se vale concorrer e para redigir declarações — nunca
declare mais do que esta matriz sustenta.

Legenda: 🟢 atende · 🟡 atende parcialmente · 🔴 não atende.

> **Regra de ouro.** Nenhum item sobe para 🟢 antes de aceite pelo sistema
> oficial correspondente. Ver `src/lib/conformance.ts` e a Definição de Pronto no
> [CLAUDE.md](../CLAUDE.md).

## Plataforma (comum a qualquer edital de software)

| Requisito | Situação | Evidência / pendência |
|---|---|---|
| Multi-tenant com perfis e permissões | 🟢 | RBAC com escopo por unidade |
| Menor privilégio | 🟡 | Modelo correto, mas autorização fail-open por omissão (O0-08) |
| Trilha de auditoria (autor, data, antes/depois) | 🟡 | `audit_events` em 9 de 24 módulos (O0-11) |
| Autenticação forte / MFA | 🔴 | Sem MFA (O0-09) |
| Criptografia em trânsito e repouso, hospedagem nacional | 🟡 | Depende de provedor + documentação |
| Relatórios exportáveis (PDF/CSV/XLSX) | 🟡 | Existe para folha; motor não generalizado |
| Web responsiva / PWA | 🟢 | — |
| LGPD documental (RIPD, política, incidentes) | 🔴 | Trilha de habilitação, não código |

## RH, Folha e Ponto

| Requisito | Situação | Evidência / pendência |
|---|---|---|
| Cadastro de pessoas, vínculos, estrutura organizacional | 🟢 | — |
| Rubricas versionadas e memória de cálculo | 🟢 | AST auditável com checksum |
| Ciclo de folha com aprovação e fechamento | 🟢 | Segregação de funções, lock otimista |
| Tabelas fiscais versionadas por vigência | 🟢 | `fiscal_tables`/`fiscal_table_versions` por vigência e ente, checksum na memória (O1-01/O1-01b); `payroll_config` aposentado |
| RPPS | 🟡 | Computável por configuração: write-path de tabela do ente + `table_lookup` (O1-02a). Falta a entidade de regime e a atribuição por regime (O1-02b) |
| Ponto eletrônico Portaria 671 (AFD/AEJ/NSR) | 🔴 | Só batida manual sem valor probatório (O1-03) |
| Rescisão e férias com INSS/IRRF | 🟡 | Aritmética simplificada (O1-05) |
| eSocial | 🔴 | Fila sem geração/assinatura/transmissão (O1-06) |
| Remessa bancária CNAB 240 | 🔴 | Formato próprio, não CNAB 240 (O1-07) |
| Exportação para TCE/SIOPE | 🔴 | CSV genérico, não os layouts oficiais |

## ERP de gestão pública (Ondas 2–6)

| Área | Situação |
|---|---|
| Orçamento (PPA/LDO/LOA) | 🔴 |
| Contabilidade PCASP (empenho→liquidação→pagamento) | 🔴 |
| Tesouraria | 🔴 |
| Tributação e receita (IPTU/ISS/ITBI, dívida ativa, NFS-e) | 🔴 |
| Materiais (compras 14.133, contratos, patrimônio, frotas, PNCP) | 🔴 |
| Protocolo e processo eletrônico | 🔴 |
| Controle interno | 🟡 (só a trilha técnica) |
| Portal da transparência | 🔴 |

## Leitura para editais analisados

- **CREFITO-8 PE 22/2026** (monitoramento de produtividade) — 🔴 objeto
  diferente; o produto não é software de monitoramento de estação.
- **MPAC PE 025/2026** (gestão de clínicas/PEP) — 🔴 domínio saúde.
- **TJBA PE 054/2026** (alocação de perfis de TI) — 🔴 é body shop, não venda de
  software; barreira patrimonial de R$ 11,9 mi.
- **Timóteo PE 033/2026** (ERP público) — 🟡 cobre ~1 de 9 áreas; exige ≥80% e
  veda subcontratação. Falta o Anexo I (TR) para calcular pontos.

Conclusão: o nicho vendável hoje é **folha/ponto isolados** para órgãos pequenos,
após concluída a Onda 1. Um ERP completo é horizonte de anos e de equipe.
