# Backlog

Fonte da verdade do que fazer a seguir. O **porquê** de cada onda está em
[`ROADMAP_GESTAO_PUBLICA.md`](ROADMAP_GESTAO_PUBLICA.md); aqui está o **o quê**, em
itens executáveis.

Formato: `ID — título`, prioridade (P0 bloqueante · P1 · P2), estimativa,
dependências e status (`✅ feito` · `em andamento` · `pendente`). Ondas 0 e 1 em itens
de 1–6 dias; Ondas 2–6 em épicos, porque detalhar hoje o que será construído
daqui a um ano produz backlog que envelhece antes de ser lido.

Este documento ocupa o lugar do "backlog da Etapa 1 (22 épicos, 102 pontos)" que
os relatórios de sprint citavam como fonte e que nunca existiu no repositório.

---

## Onda 0 — Saneamento da fundação

Pergunta que responde: _a base aguenta receber oito domínios novos?_
Encerra quando: isolamento de tenant provado por teste, autorização fail-closed,
CI verde a cada push, e nenhuma falsa conformidade declarável.

### ✅ O0-01 — Aplicar as migrations num banco real

P0 · feito. As 39 migrations + bootstrap aplicaram em PostgreSQL 16 real
(71 tabelas, 126 policies, 50 permissões), reaplicação idempotente. Corrigido de
quebra: lockfile dessincronizado que fazia `npm ci` — e portanto o `Dockerfile` —
abortar.

### ✅ O0-02 — Travar `UPDATE` sem filtro e vazamento de erro

P0 · feito. `src/lib/pgrest.server.ts`: `UPDATE` sem filtro reescrevia a tabela
inteira (o `DELETE` já tinha trava, o `UPDATE` não); mensagem crua do PostgreSQL
ia ao cliente. Ambos corrigidos, com teste de mutação em
`tests/pgrest-guards.test.mjs`.

### ✅ O0-03 — Remover falsa conformidade dos módulos-fachada

P0 · feito. `RASCUNHO_*` nos rótulos, eSocial falha explicitamente,
`src/lib/conformance.ts` registra o status. Validadores 10/11/12 invertidos:
antes certificavam a conformidade falsa, agora falham se algum rótulo voltar.

### ✅ O0-04 — CI e catraca de qualidade

P0 · feito. `.github/workflows/ci.yml` (5 jobs) + `scripts/quality-ratchet.mjs`.

### ✅ O0-05 — Documentação de continuidade

P1 · feito. README, CLAUDE.md, este backlog, `docs/` (arquitetura, glossário,
conformidade, ADRs), histórico arquivado.

### ✅ O0-06 — Fechar o furo de isolamento de tenant no shim

P0 · feito. `QueryReq` ganhou `tenant_id`, o shim (`client.ts`) o anexa a partir
de `localStorage["meuponto.activeTenantId"]`, e `dbQuery` o valida com
`loadTenantAccess` (um tenant forjado é barrado antes do compilador).
`ALLOWED_TABLES` virou registro com união discriminada (`direct` / `via_member` /
`global`) — tabela nova sem estratégia não compila. Sem tenant ativo, a leitura
cai para as próprias linhas e a escrita sem filtro segue bloqueada; login,
bootstrap e telas do funcionário preservados. Provado ponta a ponta em
PostgreSQL 16 real com dois entes e um RH em cada; +6 testes com prova de
mutação. Sem migration.

### O0-07 — Forçar `user_id` em `time_entries` e remover delete sem trilha

P0 · 1 dia · depende de O0-06 · **pendente (próximo)**

Problema. RH grava batida com `user_id` arbitrário e a policy `te_rh_delete`
permite apagar batida sem rastro — invalida o valor probatório do ponto.

Abordagem. `policyFor` força `user_id` no insert; substituir DELETE por
`deleted_at` + motivo + `audit_events`. Inverter o teste que hoje documenta o
defeito em `tests/pgrest-guards.test.mjs`.

Aceite.

- [ ] insert de batida ignora `user_id` da requisição e usa o do contexto
- [ ] não há caminho que apague `time_entries` fisicamente

### O0-08 — Guard `withTenant` fail-closed + teste de cobertura

P0 · 2 dias

Problema. Autorização é fail-open por omissão. Nada detecta um handler novo sem
`requireTenantPermission`.

Abordagem. Invólucro `withTenant(permission, handler)` em
`src/lib/tenant-access.server.ts`; teste de CI que falha se um `createServerFn`
em `*.functions.ts` não referenciar `loadTenantAccess` sem estar em allowlist
comentada. Conectar o pool com role **não-dono e sem BYPASSRLS**.

Aceite.

- [ ] handler novo sem permissão declarada quebra o teste
- [ ] pool conecta como role não-dono

### O0-09 — MFA (TOTP) para permissões críticas

P0 · 3 dias

Abordagem. `security_permissions.criticidade` já tem `normal|sensivel|critica`.
`requireTenantPermission` passa a exigir `mfa_verified_at` recente quando
`critica`. TOTP com `node:crypto`; `input-otp` já é dependência. Uma mudança em
uma função cobre as 5 permissões críticas de hoje e todas as futuras.

Aceite.

- [ ] `payroll.cycles.close` exige segundo fator
- [ ] fluxo de cadastro e verificação de TOTP com códigos de recuperação

### O0-10 — Aposentar a ponte legada de permissões

P1 · 3 dias · depende de O0-08

Problema. `tenant-access.server.ts:106-189` concede as 52 permissões a quem for
`admin` legado — escalação de privilégio entre entes.

Abordagem. Migration que materializa cada regra como papel real; flag
`LEGACY_ROLE_BRIDGE` com telemetria; virar `off`; deletar. Último consumidor a
migrar: `AppShell.tsx`.

### O0-11 — Helper de auditoria compartilhado

P1 · 2 dias

Abordagem. `src/lib/audit.server.ts` com `recordAudit(client, {...})`; cobrir os
módulos de saída de dados hoje descobertos (remessa, exportação, eSocial,
migração histórica); teste que falha se um `*.functions.ts` que escreve não o
importa.

### O0-12 — Converter validadores de grep em testes reais

P1 · 5 dias

Abordagem. `tests/helpers/pglite.mjs` reaproveitando `db-dryrun.mjs`; migrar as
Sprints 8-20 de `String.includes()` para `node:test` com casos negativos, no
padrão das Sprints 1-7. Deletar cada `validate-sprintN.mjs` ao substituir.

### O0-13 — Unificar as duas gerações de modelo

P1 · 5 dias · depende de O0-06

Abordagem. Separar semanticamente (não fundir): `profiles`=login,
`persons`=registro civil, `employment_links`=vínculo. Congelar `payroll_periods`
(copiar para `historical_records`) e **remover `/rh/folha` do menu** — duas telas
de folha inviabilizam demonstração de PoC.

### Dívidas menores registradas (P2)

- Remover os 6 `scripts/reconcile-sprint*.sql` órfãos que nenhum script executa.
- `test:all` que rode a suíte inteira de validadores.
- Corrigir o operador `is` em `pgrest.server.ts` (`IS $1` é SQL inválido para não-nulo).
- Migrar `.validator()` (deprecado, 65 usos) para `.inputValidator()`.

---

## Onda 1 — Tornar RH/Folha/Ponto vendável

Pergunta: _a folha se vende sozinha e gera o primeiro atestado?_
Encerra quando: folha de município com RPPS calculada ponta a ponta, ponto
conforme Portaria 671, eSocial transmitido em homologação, CNAB 240 real aceito
por um banco.

### O1-01 — Tabelas fiscais versionadas + nó `table_lookup`

P0 · 6 dias. `fiscal_tables` + `fiscal_table_versions` (vocabulário de
`payroll_rubric_versions`); nó `table_lookup` na AST — `table` é código, não
dados; zero I/O no avaliador. Aposentar `payroll_config`. Aceite: INSS/IRRF
progressivos calculados em cada limite de faixa, com o checksum da versão na
memória de cálculo.

### O1-02 — RPPS como configuração

P0 · 4 dias · depende de O1-01. `pension_regimes` por ente; contribuição do
servidor, patronal e de inativos como rubricas com `table_lookup`.

### O1-03 — Ponto conforme Portaria MTP 671/2021

P0 · 3-4 semanas. NSR, AFD, AEJ, espelho, comprovante ao trabalhador, marcações
imutáveis encadeadas, tabela de feriados, tolerância legal, banco de horas.
Trazer `time_entries` para dentro do multi-tenant. Aceite: AFD e AEJ validados
por ferramenta oficial.

### O1-04 — Ligar as ilhas

P1 · 4 dias. O ponto alimenta a folha; `payroll_monthly_variables` passa a ser
lida por `runPayrollSimulation`.

### O1-05 — Rescisão e férias corretas

P1 · 1 semana. Hoje ambas são aritmética simplificada, sem INSS/IRRF. Conferir
contra cálculo manual.

### O1-06 — eSocial real

P0 · 3-6 semanas · ⚠️ pode exigir HSM para A3. Geração de XML, assinatura
XMLDSig, transmissão e retorno. Aceite: evento aceito no ambiente de homologação
da Receita, com recibo. **Ver ADR — pode ser declarado não atendido.**

### O1-07 — CNAB 240 real (um banco) + parser de retorno

P0 · 6-8 dias. `src/lib/cnab/` com descritores de campo declarativos e writer
**puro** (testável sem banco); um banco (BB ou Caixa); parser de retorno (insumo
da Tesouraria na Onda 2). Aceite: arquivo aceito pelo banco; posições conferidas
contra o manual.

### O1-08 — Interface de empenho da folha

P1 · 1 semana. A folha emite requisição de empenho no formato PCASP, para o
modelo de dados nascer certo antes da Onda 2.

---

## Ondas 2–6 — épicos

Detalhadas quando a Onda 1 fechar. Sequência e justificativa em
`ROADMAP_GESTAO_PUBLICA.md`.

### Onda 2 — Núcleo SIAFIC (12-16 sem)

Orçamento (PPA/LDO/LOA, créditos adicionais) · contabilidade PCASP (empenho →
liquidação → pagamento, restos a pagar, encerramento) · tesouraria (OB,
conciliação) · balanços Lei 4.320, DCASP, MSC para o SICONFI. Reusa o workflow de
`payroll_cycles` como motor de documentos contábeis; RLS de verdade nasce aqui.

### Onda 3 — Materiais e Contratações (14-18 sem)

Compras Lei 14.133 → contratos → almoxarifado → patrimônio (depreciação NBC TSP)
→ frotas → integração PNCP. Emite empenho pelo mesmo primitivo da folha.

### Onda 4 — Tributação e Receita (14-20 sem)

Cadastros imobiliário/mobiliário · IPTU, ISS, ITBI · dívida ativa (CDA, execução
fiscal) · NFS-e padrão nacional · certidões.

### Onda 5 — Apoio, controle e transparência (10-14 sem)

Protocolo e processo eletrônico com ICP-Brasil · e-SIC/LAI · controle interno ·
Portal da Transparência (LC 131/2009, dados abertos, acessibilidade).

### Onda 6 — Conformidade contínua ⚠️ (contínuo)

Layout do TCE estadual (um por vez; a referência de Timóteo é SICOM/MG, não
TCE-CE) · manutenção legal permanente. **Aqui o gargalo deixa de ser código** —
suporte, NOC, migração de legados exigem equipe.

---

## Trilha paralela — Habilitação para licitar

Roda junto com as ondas. Conformidade documental (RIPD, política de tratamento,
hospedagem nacional, plano de incidentes) · habilitação (ME/EPP, LC/SG/LG > 1,
SICAF, ICP-Brasil, PNCP) · **o primeiro atestado**, via dispensa (art. 75 da Lei
14.133) num órgão pequeno com o escopo da Onda 1. Sem atestado, o produto não
entra em pregão algum.
