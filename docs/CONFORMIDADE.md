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
| Menor privilégio | 🟡 | RBAC com escopo por unidade; rede por AST (`authorization-coverage`) barra no CI handler de tenant sem guard (O0-08). RLS inerte por decisão (ADR 0002) — a autorização é 100% aplicacional |
| Trilha de auditoria (autor, data, antes/depois) | 🟡 | `recordAudit` compartilhado (O0-11), em 19 de 34 módulos `*.functions.ts`; falta cobrir o restante |
| Autenticação forte / MFA | 🟡 | TOTP entregue (`mfa.server.ts`), cifrado em repouso (`MFA_ENC_KEY`), exigido em operações críticas via `requireCriticalMfa` (O0-09); ainda não universal |
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
| RPPS | 🟢 | Tabela do ente (O1-02a), regime como dado de primeira classe (O1-02b), rubricas aplicadas automaticamente por regime no ciclo com checksum na memória (O1-02c), tela de regimes + mapeamento de rubricas + seletor na ficha da pessoa (O1-02d) e tela de versionamento das tabelas fiscais do ente (O1-02e). Linha completa |
| Ponto — base probatória (NSR + marcação imutável encadeada) | 🟡 | `time_clock_punches` append-only, NSR por ente, encadeamento SHA-256 verificável (O1-03a); espelho + comprovante interno (O1-03c); feriados por ente (O1-03d); apuração previsto×trabalhado com tolerância legal e extras/faltas (O1-03e) |
| Ponto eletrônico Portaria 671 (AFD/AEJ oficiais) | 🔴 | Exportação oficial pendente de homologação por ferramenta oficial (O1-03b) |
| Rescisão com INSS/IRRF | 🟢 | INSS progressivo + IRRF por faixa pelo motor fiscal versionado, em trilhas separadas (saldo de salário e 13º em tributação exclusiva); verbas indenizatórias isentas; `inss_amount`/`irrf_amount` e provenância na memória (O1-05a). Regime celetista/temporário |
| Férias com INSS/IRRF | 🟢 | `depositVacationToPayroll` deposita a remuneração (base + 1/3) em `payroll_monthly_variables`; o ciclo tributa a base combinada com o salário (teto único do INSS), com recomposição provada por teste (O1-05b) |
| Empenho da folha (interface PCASP) | 🟡 | Requisição de empenho de folha fechada, por natureza de despesa, linhas somam a despesa bruta (O1-08). Interface para a Onda 2; a emissão/reserva/escrituração no SIAFIC nasce na Onda 2 |
| eSocial | 🔴 | Fila sem geração/assinatura/transmissão (O1-06) |
| Remessa bancária CNAB 240 | 🔴 | Formato próprio, não CNAB 240 (O1-07) |
| Exportação para TCE/SIOPE | 🔴 | CSV genérico, não os layouts oficiais |

## ERP de gestão pública (Ondas 2–6)

| Área | Situação |
|---|---|
| Orçamento (PPA/LDO/LOA) | 🟡 — dotação orçamentária (LOA) em `budget_appropriations` por classificação, com orçado/empenhado/saldo e permissões `budget.*` (O2-01). Falta PPA/LDO, créditos adicionais e a reserva pelo empenho |
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
