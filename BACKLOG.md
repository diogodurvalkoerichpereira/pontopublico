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

### ✅ O0-07 — Forçar `user_id` em `time_entries` e remover delete sem trilha

P0 · feito. O shim passou a criar só a própria batida (força `user_id` do
contexto no insert) e a **negar** update/delete de `time_entries`; a leitura
filtra `deleted_at IS NULL`. Criação/edição/exclusão pelo RH foram para
`src/lib/timesheet.functions.ts` — server functions que validam que o
funcionário pertence ao ente ativo e gravam `audit_events`; a exclusão é lógica
(soft-delete) com motivo obrigatório. Migration adicionou `deleted_at/by`,
`delete_reason`, `updated_at/by`, índice parcial de leituras vivas e removeu a
policy `te_rh_delete`. Tela `rh.funcionarios.$id.tsx` migrada para as server
functions. Provado em PostgreSQL 16 real; +4 testes de compilador com mutação.
`ponto.tsx` (self-punch) inalterado.

### ✅ O0-08 — Guard `withTenant` fail-closed + teste de cobertura

P0 · feito. `withTenant(userId, tenantId, permission, fn)` em
`src/lib/tenant-access.server.ts` reúne `loadTenantAccess` +
`requireTenantPermission` numa chamada. `tests/authorization-coverage.test.mjs`
varre por **AST** (compiler API do TS) todo `createServerFn` em
`*.functions.ts` e falha o CI se um handler não alcançar um guard
(`loadTenantAccess`/`withTenant`/`loadTenantUnitScope`, direto ou por helper
local como `assertPersonScope`) sem estar na allowlist comentada. Corrigido o
único fail-open real: **`publishClosedPayroll`** publicava contracheques de
qualquer ente com só `requireAuth` — agora valida membership +
`payroll.cycles.close` + input zod. Verificado por mutação. O pool com role
não-dono foi **adiado para a Onda 2** (só compensa com RLS ativa, ADR 0002).

### ✅ O0-09 — MFA (TOTP) para operações de alto risco

P0 · feito. Segundo fator TOTP (RFC 6238) para um **conjunto restrito** de
permissões de alto risco — `security.manage`, `tenant.manage`,
`payroll.cycles.close`, `payroll.cycles.reopen` (`PROTECTED_MFA_PERMISSIONS` em
`tenant-access.server.ts`) — e **não** todas as `critica`, que incluem rotina de
RH. Verificação **uma vez por sessão**: `verifyMfa` carimba
`private.auth_sessions.mfa_verified_at`; `requireCriticalMfa(permission,
context.mfaVerifiedAt)` lança `MFA_REQUIRED` (fail-closed) nos 3 sites de
`security.manage` (`organization.functions.ts`) e em `transitionPayrollCycle`
(`payroll-cycle.functions.ts`, permissão dinâmica). Cripto em `mfa.server.ts`
(só `node:crypto`): TOTP base32/HMAC-SHA1, segredo cifrado em repouso com
**AES-256-GCM** sob `MFA_ENC_KEY` dedicada, códigos de recuperação com hash
scrypt consumidos ao usar. Server functions em `mfa.functions.ts` (enroll,
confirm, verify, disable, status). Cliente: challenge (`mfa-challenge.tsx`) nos
2 pontos de chamada e painel self-service em `/conta/seguranca`. Verificado:
vetores oficiais da RFC 6238, round-trip AES (com adulteração), guard por
mutação (`tests/mfa.test.mjs`) e **ponta a ponta em PostgreSQL 16 real**
(enroll→confirm→verify, `text[]` de backup, `on delete cascade`).

Aceite.

- [x] `payroll.cycles.close`/`reopen` e `security.manage` exigem segundo fator
- [x] fluxo de cadastro e verificação de TOTP com códigos de recuperação
- [ ] reset de MFA por admin quando o usuário perde o TOTP (P2 — hoje `disableMfa`
      exige um código válido)

### ◑ O0-10 — Aposentar a ponte legada de permissões

P1 · Incremento 1 **feito**; Incrementos 2-3 pendentes.

Problema. `tenant-access.server.ts` concedia o catálogo inteiro a quem fosse
`admin` legado, em **todo** tenant do qual é membro — escalação de privilégio
entre entes.

**Incremento 1 (feito).** Migration `20260908050000_o0_10_reconcile_legacy_roles`
materializa a união do RH legado no papel real `rh_operador` (47 permissões =
catálogo exceto `tenant.manage`/`security.manage`/`audit.read`), reafirma
`tenant_admin` completo e faz backfill do RH; **sem backfill de admin**. Flag
`LEGACY_ROLE_BRIDGE` (default `on`) gira a união legada; `loadTenantAccess` emite
telemetria `LEGACY_BRIDGE_DEPENDENCY` (on **e** off) de quem só a ponte
concederia. `adminCreateUser` passa a atribuir `rh_operador` ao RH novo. Teste de
comportamento (A/B/C) verificado por mutação; verificado em PostgreSQL 16 real
(rh_operador=47, tenant_admin=50). Ver ADR 0014.

**Incremento 2 (só env).** `LEGACY_ROLE_BRIDGE=off` no Coolify quando a telemetria
zerar; remover o curto-circuito `isAdmin ||` de `hasTenantPermission`
(`auth-context.tsx:171-172`). Rollback instantâneo pela env.

**Incremento 3 (limpeza).** Deletar o bloco da ponte e a chamada `loadAccess` de
`tenant-access.server.ts`; remover a flag; migrar o `hasPermission` legado do
menu — **`AppShell.tsx` por último**. `configure_schedules`/escalas fica legado
até haver `schedules.*`.

**Follow-ups à parte.** O0-10b — migrar os gates de **admin global**
(`adminCreateUser`, `adminResetPassword`, `adminUpdateUserEmail`,
`adminDeleteUser`, `rhUploadEmployeeDocument`, `requireAdmin` do SMTP) para um
conceito de _platform admin_ (hoje autorizam por admin legado global, não pela
ponte). `pgrest.policyFor` (motor de política do shim) → Onda 2.

### ✅ O0-11 — Helper de auditoria compartilhado

P1 · feito. `src/lib/audit.server.ts` centraliza a escrita da trilha:
`recordAudit(client, event)` (atômico dentro de `withTransaction`) e
`recordAuditQ(event)` (fora de transação), com `request_id`/`ip` e serialização
jsonb idênticos em toda a aplicação. Os ~10 writers que reimplementavam o insert
passaram a chamar o helper e os **4 módulos de saída de dados** que não gravavam
trilha — remessa bancária, exportação oficial, eSocial (enfileiramento), migração
histórica (fechamento) — agora registram o ato. Nenhum `insert into
public.audit_events` cru permanece fora de `audit.server.ts`. Rede dupla
(`tests/audit-helper.test.mjs`): teste de comportamento do `recordAudit`
(SQL/params/jsonb/metadados, esbuild+stub) + conformidade (lint) que falha se
voltar um insert cru ou se um módulo de saída não importar o helper. Ver ADR 0015.

### ✅ O0-12 — Converter validadores de grep em testes reais

P1 · **feito**. Nenhum validador grep sobra (só os reais das Sprints 1-6).

Problema. As Sprints 8-20 só tinham "validadores" que liam o arquivo como string
(`String.includes()`) — foi como a Sprint 19 passou com erro de sintaxe e a 13
com coluna inexistente. E não rodavam no CI (scripts `test:sprintN` órfãos).

**Incremento 1 (feito).** Helper compartilhado `tests/helpers/pglite.mjs`
(`migrationFiles()` + `createTestDb()`) sobe o esquema real em PGlite;
`scripts/db-dryrun.mjs` passou a importar `migrationFiles()` (fonte única da
ordem). Convertidas as **Sprints 8, 10, 11, 12**: `tests/sprint08-ferias.test.mjs`
executa os CHECKs e o trigger `trg_validate_vacation` (>3 frações, saldo,
pagamento antecipado); `tests/conformidade-saida.test.mjs` afere em runtime
`conformanceOf` (remessa/exportação `rascunho`, eSocial `nao-implementado`), o
esquema real (tabelas de saída existem; eSocial não guarda chave privada) e a
honestidade dos rótulos na fonte (lint). Verificado por mutação (quebrar o
trigger na migration ou virar o status de conformidade derruba o teste — o grep
antigo não pegava). Deletados os 4 validadores e seus scripts. Ver ADR 0016.

**Incremento 2.** Sprints **9** (CHECKs de file_sha256/status/file_type + unique),
**18** (`resolveSemanticIntent` em runtime prova a whitelist + sem SQL livre) e
**20** (CHECK de status + unique idempotente `(job_id,source_key)`).

**Incremento 3 (encerra).** Sprints **7** (rescisão: `worked_days`/checksum +
trigger cross-tenant + conta = 16000), **13** (portal: CHECKs de document_type/
sha256 + policy self), **14** (KPIs: checksum + unique), **15** (push: CHECKs de
title/status + unique), **16** (data mart: schema `analytics` privado provado por
`has_schema_privilege(...)=false`), **17** (LRF: função pura `classifyLrf` extraída
e testada + CHECKs dos limites) e **19** (suporte: CHECKs de body/status + policy
de participante). Verificado por mutação em cada um; RLS não é imposta em PGlite
(dono), então `auth.uid()` é aferido por `pg_policies`. Os 3 incrementos deletaram
os 14 validadores grep e seus scripts. Os validadores reais das Sprints 1-6 ficam
como estão (já executam). Ver ADR 0016.

Restam P2 à parte: os 6 `reconcile-sprint*.sql` órfãos; um `test:all` agregado.

### ✅ O0-13 — Unificar as duas gerações de modelo

P1 · feito. **Uma folha só.** A folha legada `payroll_periods` (grão usuário/mês,
tela `/rh/folha`) foi aposentada: rota deletada, item de menu removido
(`AppShell.tsx`), `payroll_periods` retirada do `TABLE_REGISTRY`/política do shim
(`pgrest.server.ts`) — sem registro, `dbQuery` não a alcança, e ela vira arquivo
read-only (**congelar in-place**, ADR 0017 refinando ADR 0005; sem cópia frágil
para `historical_records`, que é acoplado ao motor de jobs e vazio no deploy).
`payroll_config` e `@/lib/payroll` foram **mantidos** (compartilhados com a folha
nova). `routeTree.gen.ts` regenerado pelo build. A folha válida é `payroll_cycles`
(`/rh/ciclos`). Identidade (`profiles`=login, `persons`=civil,
`employment_links`=vínculo) já estava separada por ADR 0004 + esquema — documentada
agora no GLOSSARIO e ARQUITETURA, e corrigida a coluna-fantasma da ADR 0004 (o elo
é `profiles.person_id`). `tests/folha-unica.test.mjs` (comportamento: shim recusa
`payroll_periods`; lint: `/rh/folha` fora do menu e do código), verificado por
mutação. **Fecha a Onda 0.**

Fora de escopo: cópia real para `historical_records` (se houver dados legados; o
motor genérico já existe); endurecer o atalho `personId=id` (sem CPF).

### Dívidas menores registradas (P2)

- Remover os 6 `scripts/reconcile-sprint*.sql` órfãos que nenhum script executa.
- `test:all` que rode a suíte inteira de validadores.
- Corrigir o operador `is` em `pgrest.server.ts` (`IS $1` é SQL inválido para não-nulo).
- Migrar `.validator()` (deprecado, 65 usos) para `.inputValidator()`.
- Exigir `requireAuth` nos proxies de OCR (`extractAtestadoOCR`,
  `extractDocumentoOCR`): hoje são endpoints públicos que consomem a
  `LOVABLE_API_KEY` — risco de abuso do serviço pago, não de tenant.

---

## Onda 1 — Tornar RH/Folha/Ponto vendável

Pergunta: _a folha se vende sozinha e gera o primeiro atestado?_
Encerra quando: folha de município com RPPS calculada ponta a ponta, ponto
conforme Portaria 671, eSocial transmitido em homologação, CNAB 240 real aceito
por um banco.

### ✅ O1-01 — Tabelas fiscais versionadas + nó `table_lookup`

P0 · 6 dias. **Feito.** `fiscal_tables` + `fiscal_table_versions` (vocabulário
de `payroll_rubric_versions`), com trigger de não-sobreposição de vigências
publicadas e convenção `tenant_id` nulo = tabela nacional (INSS/IRRF federais).
Nó `table_lookup` na AST (`src/lib/payroll-formula.ts`) — `table` é código, não
dados; dois modos (`progressive` p/ INSS, `bracket` p/ IRRF); as versões chegam
pré-carregadas num `Map` (`loadFiscalTables`), então o avaliador continua **puro,
sem I/O**. O id + checksum da versão entram na memória de cálculo. Threaded no
ciclo (`payroll-simulation.functions.ts`). Seed federal 2025 (`INSS_FEDERAL`,
`IRRF_FEDERAL`) com checksum pré-computado que o loader reconfere. Aceite
cumprido: INSS/IRRF progressivos calculados em cada limite de faixa, com o
checksum da versão na memória — validado por `tests/fiscal-table-lookup.test.mjs`
(puro) e `tests/sprint-fiscal-tables.test.mjs` (PGlite + PG16 real). Ver ADR 0003.

### ✅ O1-01b — Repointar consumidor vivo e aposentar `payroll_config`

P0 · 2-3 dias · depende de O1-01. **Feito.** O 13º
(`payroll-special.functions.ts`) foi repontado de `payroll_config` para
`loadFiscalTables` (competência = `${reference_month}-01`), com id+checksum das
versões na `tax_snapshot` (ADR 0003). A matemática de faixa unificou-se em
`progressiveLookup`/`bracketLookup` (exportados de `payroll-formula.ts`), **fonte
única** — os helpers duplicados de `payroll-special.ts` saíram. `payroll_config`
foi **congelado in-place** (fora do `TABLE_REGISTRY` e do `policyFor` do shim; sem
migration — padrão O0-13/ADR 0017). Testes: `tests/decimo-terceiro-fiscal.test.mjs`
(novo — o 13º passa a ter teste) e o flip de `tests/folha-unica.test.mjs`; ambos
verificados por mutação. A rescisão nunca usou `payroll_config`.

### ✅ O1-02a — Write-path das tabelas fiscais do ente (habilita RPPS)

P0 · depende de O1-01. **Feito.** `src/lib/fiscal-tables.functions.ts`
(`getFiscalTables`/`saveFiscalTable`/`saveFiscalTableVersion`), guardado por
`fiscal.read`/`fiscal.manage`, espelhando `savePayrollRubricVersion` (rascunho →
publicada, publicada imutável, checksum server-side que o loader reconfere,
auditado). Só tabelas do ente (`tenant_id` do ente; nacionais seguem por
migration). **Sem migration** — write-path de app sobre o schema do O1-01. Com
isso o RPPS já roda ponta a ponta sobre a infra existente: o ente cria
`RPPS_<ENTE>`, uma rubrica de desconto com `table_lookup` contra ela é atribuída
aos estatutários (`employment_link_rubrics`) e o ciclo calcula progressivo com
checksum na memória. Testes: `tests/sprint-fiscal-tables-admin.test.mjs` (PGlite,
inclui override do ente sobre a nacional e o cálculo RPPS ponta a ponta),
verificado por mutação.

### ✅ O1-02b — RPPS como entidade de primeira classe

P0 · depende de O1-02a. **Feito.** `pension_regimes` por ente (RPPS/RGPS) +
`employment_links.pension_regime_id` com integridade referencial e **coerência de
tenant** no trigger `validate_employment_link` (re-declarado, com
`pension_regime_id` na lista `update of`). `pension-regimes.functions.ts`
(get/save, guardado por `people.read`/`people.manage`, dedup por código, auditado)
e o `pension_regime_id` ligado em `people.functions.ts` (zod, precheck, INSERT/
UPDATE, leitura). O regime deixa de ser texto livre. Teste
`tests/sprint-pension-regimes.test.mjs` (PGlite: CRUD, persistência via
`savePersonAndLink`, coerência cross-tenant), verificado por mutação. **Não toca**
o hot path do ciclo nem `employment_link_rubrics`.

### ✅ O1-02c — Atribuição de rubricas por regime

P0 · depende de O1-02b. **Feito.** `pension_regime_rubrics` (regime→rubrica, com
trigger de coerência de entidade) + `get/setPensionRegimeRubrics`
(`pension-regimes.functions.ts`, guardado por `payroll.simulate`/
`payroll.assignments.manage`). O ciclo (`payroll-simulation.functions.ts`) agora
carrega, além das atribuições por vínculo, as rubricas do **regime** de cada
vínculo e faz o merge com dedup — a atribuição explícita por vínculo tem
precedência (sem dupla contagem). Assim o RPPS aplica-se a todo estatutário **sem
atribuição manual**. O motor puro (ADR 0003) não muda: só a camada de seleção.
Teste `tests/sprint-pension-rubrics.test.mjs` roda a folha **ponta a ponta**
(tabela do ente → rubrica `table_lookup` → mapeamento → servidor no regime →
`runPayrollSimulation` com o valor progressivo e o checksum na memória),
verificado por mutação.

### O1-02d — UI de previdência (RPPS)

P1 · depende de O1-02c. Tela de regimes + mapeamento de rubricas, seletor de
regime em `rh.pessoas.tsx` (SelectField), tela do write-path de tabelas fiscais.
Só interface — o back-end de RPPS está completo (O1-02a/b/c). Eventual
`base_code='rpps'` (widen do CHECK de `payroll_rubric_incidences`) se uma rubrica
de RPPS precisar compor uma base própria.

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
