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

### O1-02d — UI de previdência (RPPS) ✅

P1 · feito (parcial). Rota `rh.previdencia.tsx` (menu RH → Previdência,
`people.read`): lista/cria/edita regimes (RPPS/RGPS) e mapeia as rubricas de
contribuição por regime, consumindo `getPensionWorkspace` (agregador novo:
regimes + catálogo de rubricas ativas + mapa regime→rubricas), `savePensionRegime`
e `setPensionRegimeRubrics`. O agregador tem teste de comportamento
(`tests/sprint-pension-workspace.test.mjs`) verificado por mutação. **Ainda
pendente nesta linha** (registrado, sem bloquear): seletor de regime em
`rh.pessoas.tsx` (gravar `employment_links.pension_regime_id` pela tela) e a tela
do write-path de tabelas fiscais do ente (O1-02a já tem back-end). Eventual
`base_code='rpps'` (widen do CHECK de `payroll_rubric_incidences`) se uma rubrica
de RPPS precisar compor base própria.

### ✅ O1-03a — Registro de ponto imutável e encadeado (base probatória)

P0. **Feito.** `time_clock_punches` (multi-tenant, append-only) com **NSR
sequencial por ente** e **encadeamento SHA-256** (cada marcação carrega o hash da
anterior); `time_clock_counters` travado com `FOR UPDATE` gera NSR/cadeia sem
corrida; trigger que **recusa todo UPDATE/DELETE** (correção = nova marcação).
`time-clock.functions.ts` (`recordTimeClockPunch`/`getTimeClockPunches`/
`verifyTimeClockChain`, guardados por `people.manage`/`people.read`) e
`time-clock.server.ts` (hash canônico, fonte única). Teste
`tests/sprint-time-clock.test.mjs` (NSR, cadeia, imutabilidade, detecção de
adulteração em nível de banco), verificado por mutação + PostgreSQL 16 real. **Base
interna** — não declara conformidade Portaria 671 (isso é O1-03b, exige
homologação).

### O1-03b — AFD/AEJ oficiais (⚠️ exige homologação)

P0 · depende de O1-03a. Exportação **AFD** e **AEJ** no layout oficial da Portaria
MTP 671/2021, sobre as marcações encadeadas, com assinatura. **Aceite: validados
por ferramenta oficial** antes de qualquer declaração de conformidade
(`conformance.ts`). Nenhum artefato leva o nome AFD/AEJ até passar.

### ✅ O1-03c — Espelho e comprovante ao trabalhador

P0 · depende de O1-03a. **Feito.** `time-mirror.ts` (puro, sem I/O) apura a jornada
por dia pareando as marcações **posicionalmente** (as marcações não têm tipo);
`getTimeMirror` devolve a jornada apurada e `getPunchReceipt` o comprovante interno
(NSR + `record_hash` como código verificador, servidor identificado, CPF mascarado
sem `people.sensitive.read`). Sem migration — funções puras + leitura sobre
`time_clock_punches`. Teste `tests/sprint-time-mirror.test.mjs` (pareamento,
intervalo aberto, jornada apurada, máscara de CPF), verificado por mutação.
Tolerância/feriados/banco de horas são o O1-03d; o comprovante **oficial** da
Portaria 671 é o O1-03b (exige homologação).

### ✅ O1-03d — Calendário de feriados (por ente) + marcação no espelho

P1. **Feito.** `holidays` por ente (nacional = `tenant_id` nulo, semeado com os 9
fixos federais incl. Consciência Negra; estadual/municipal/facultativo por ente;
móveis por ano). `holidays.functions.ts` (get/save, `people.read`/`people.manage`,
dedup por data). O espelho (`buildTimeMirror`/`getTimeMirror`) marca `isHoliday`/
`holidayName` por dia (fixo casa todo ano; datado só no ano certo). Teste
`tests/sprint-holidays.test.mjs`, verificado por mutação + PostgreSQL 16 real.

### ✅ O1-03e — Apuração de jornada (previsto × trabalhado, tolerância, extras/faltas)

P1. **Feito.** `apurarJornada` (puro, em `time-mirror.ts`): por dia, previsto ×
trabalhado, com **tolerância legal** (CLT art. 58 §1; desvio até o limite é
desconsiderado), extras e faltas, e feriado com previsto 0 (todo trabalho no
feriado vira extra). `getTimeApuracao` puxa a jornada semanal do vínculo
(`weekly_hours`) + feriados + marcações e apura o período. Previsto padrão:
`weekly_hours` distribuído seg-sex (`defaultExpectedByWeekday`). Sem migration.
Teste `tests/sprint-time-apuracao.test.mjs`, verificado por mutação.

### O1-03f — Escala diária customizada + banco de horas persistente

P1. Modelar a **escala diária** (rotativa, sábado, turnos) sobre `work_schedules`
— hoje o previsto é `weekly_hours` distribuído seg-sex. E o **banco de horas**
como saldo acumulado (persistente) dos extras/faltas apurados. Aposentar a leitura
user-scoped de `time_entries` em favor das marcações multi-tenant.

### ✅ O1-04 — Ligar as ilhas (ponto → folha)

P1. **Feito.** (O1-04a) `payroll_monthly_variables` passou a ser **lida** por
`runPayrollSimulation`: cada valor por vínculo/rubrica/competência entra como
`fixed_amount`, somado às atribuições por vínculo e às rubricas de regime, com
dedup de precedência (assignment > regime > variável mensal). (O1-04b)
`depositTimeApuracao` **valora** o ponto apurado (O1-03e) — extras/faltas ×
salário-hora × adicional, com **parâmetros explícitos do RH** (rubrica, adicional,
divisor; nada adivinhado) — e grava em `payroll_monthly_variables`
(re-depósito substitui, idempotente). O laço **ponto → apuração → valoração →
folha** fecha ponta a ponta. Testes `tests/sprint-monthly-variables.test.mjs` e
`tests/sprint-ponto-folha.test.mjs`, verificados por mutação.

### O1-05a — Rescisão com INSS/IRRF ✅

P1 · feito. `calculateTermination` (`employment-special.functions.ts`) deixou de
entregar o líquido sem retenção (`net = total − descontos manuais`). Agora retém
pelo motor fiscal versionado (ADR 0003): **INSS progressivo + IRRF por faixa** em
duas trilhas independentes — saldo de salário (competência final) e **13º
proporcional em tributação exclusiva** (base própria). As verbas indenizatórias —
aviso prévio indenizado (STJ REsp 1.230.957), férias indenizadas + 1/3 (Súmula 386
STJ; art. 6º V Lei 7.713) e saldo/multa FGTS — ficam **isentas** e explícitas na
memória (`exempt.total` conferível). Colunas próprias `inss_amount`/`irrf_amount`
no termo (auditável pelo TCE); provenância fiscal (id + checksum das versões) na
memória. Escopo: rescisão de regime **celetista/temporário** (modela FGTS e aviso);
a exoneração de estatutário/RPPS é outro fluxo. Migration
`20260909100000_o1_05_termination_taxes.sql`. Testes `tests/rescisao-fiscal.test.mjs`
(math puro, conferido contra cálculo manual) e `tests/sprint-rescisao-fiscal.test.mjs`
(ponta a ponta), verificados por mutação.

### O1-05b — Férias corretas pela via do ciclo ✅

P1 · feito. A retenção de férias **não** é INSS/IRRF isolado no agendamento: a
remuneração de férias integra o salário-de-contribuição da competência (teto único
do INSS). Então `depositVacationToPayroll` (`vacation.functions.ts`) deposita a
remuneração (base + 1/3) em `payroll_monthly_variables` — como o ponto no O1-04b — e
o **ciclo** tributa a base **combinada** (salário + férias) por incidências
(`payroll_rubric_incidences` → `table_lookup`). O agendamento segue o documento
bruto; o líquido nasce no ciclo. Idempotente (re-depósito substitui a competência).

Correção de hot-path junto: `runPayrollSimulation` passou a **ordenar as fontes por
`calculation_order` independente da origem** (atribuição/regime/variável mensal) —
antes as variáveis mensais eram anexadas por último, então uma rubrica que alimenta
a base (férias, extras do ponto) vinda de `payroll_monthly_variables` era calculada
**depois** do INSS/IRRF e não entrava no salário-de-contribuição. Corrige também o
laço ponto→folha do O1-04b. Teste `tests/sprint-ferias-folha.test.mjs` prova a
recomposição (salário 3000 + férias 3000 → INSS 649,60, não 253,41 nem 506,82),
verificado por mutação (remover a ordenação derruba).

### O1-06 — eSocial real

P0 · 3-6 semanas · ⚠️ pode exigir HSM para A3. Geração de XML, assinatura
XMLDSig, transmissão e retorno. Aceite: evento aceito no ambiente de homologação
da Receita, com recibo. **Ver ADR — pode ser declarado não atendido.**

### O1-07 — CNAB 240 real (um banco) + parser de retorno

P0 · 6-8 dias. **Base feita:** motor de largura fixa posicional (`src/lib/fixed-width.ts`,
`formatField`/`writeRecord` — num à direita com zeros, alfa à esquerda com espaços,
contiguidade e comprimento exato validados), puro e testado por mutação
(`tests/fixed-width.test.mjs`). É a fundação declarativa do CNAB 240 e também do
AFD/AEJ (O1-03b), ambos posicionais. **Pendente (não iniciado de propósito):** os
descritores de campo de um banco (BB/Caixa) exigem conferência **posição a posição
contra o manual FEBRABAN** — não se escreve de memória (viraria conformidade não
verificada). O writer do layout, o parser de retorno e a **homologação** (arquivo
aceito pelo banco) vêm quando o manual estiver à mão; até lá a conformidade CNAB 240
segue 🔴. Ver `src/lib/bank-remittance.functions.ts` (rascunho honesto, não-CNAB240).

### O1-08 — Interface de empenho da folha ✅

P1 · feito. Uma folha mensal **fechada** emite uma **requisição de empenho**
(`emitPayrollEmpenhoRequest`, `payroll-empenho.functions.ts`): a despesa bruta de
pessoal (proventos do ciclo) classificada por **natureza de despesa (PCASP)** em
linhas que **têm de somar** a despesa bruta — invariante testado, sem sobra nem
falta. Retenções (INSS/IRRF/consignações) são extra-orçamentárias e não entram;
obrigações patronais (3.1.90.13) entram quando o cálculo patronal existir. Uma
requisição por folha; provenância (`cycle_id`, base, linhas) + checksum na memória.
É a **interface** para a contabilidade da Onda 2 — o modelo de dados nasce certo
antes do núcleo SIAFIC. **Não** é empenho homologado no SIAFIC (a emissão, reserva
orçamentária e escrituração vêm na Onda 2), por isso o artefato é "requisição de
empenho". Guardas: `payroll.cycles.close` (emitir) / `payroll.cycles.read` (ler); um
`budget.empenho.manage` dedicado nasce na Onda 2. Migration
`20260909110000_o1_08_payroll_empenho.sql`; teste `tests/sprint-empenho-folha.test.mjs`
verificado por mutação.

### O1-09 — Consignações e margem consignável ✅

P1 · feito. Descontos consignados (empréstimo, sindicato, plano de saúde, pensão)
em `payroll_consignments` com controle de **margem consignável** (Lei 10.820/2003):
o teto padrão de **35% da remuneração de base** (`employment_links.base_salary`,
percentual configurável) é conferido na inclusão sobre a soma das parcelas ativas —
`registerConsignment` só inclui se a parcela couber na margem disponível;
`getConsignmentMargin` devolve base/teto/comprometido/disponível;
`cancelConsignment` libera a margem. Reusa `people.read`/`people.manage`. Migration
`20260909330000_o1_09_payroll_consignments.sql`; teste
`tests/sprint-consignments.test.mjs` verificado por mutação (comparar a parcela ao
teto cheio, ignorando o já comprometido, derruba). **O1-09b ✅:**
`depositConsignmentsToPayroll` deposita o total das parcelas ativas ainda devidas
(parcelas_pagas < parcelas_total) como desconto na folha da competência (rubrica
de natureza `desconto`, idempotente — re-depósito substitui), pela mesma via de
`payroll_monthly_variables` das férias/ponto. **O1-09c ✅:** `amortizeConsignment`
avança `parcelas_pagas` de uma consignação **ativa** sem passar do total e a **quita** ao
alcançá-lo (liberando a margem, pois só as ativas comprometem); consignação
quitada/cancelada não amortiza. Reusa `people.manage`, sem migration; teste
`tests/sprint-consignment-amortize.test.mjs` verificado por mutação (não quitar ao
alcançar o total derruba). **O1-09d ✅ (UI):** rota `/consignacoes` — seletor de
servidor/matrícula, cartões de margem (base, margem 35%, comprometido, disponível),
tabela das consignações ativas com ações **Amortizar** e **Cancelar**, e **Nova
consignação** (tipo, consignatário, parcela, nº, início), reusando
`getConsignmentMargin`/`registerConsignment`/`amortizeConsignment`/`cancelConsignment`;
item de menu em Recursos Humanos. **Pendente:** amortização automática no fechamento do
ciclo.

---

## Ondas 2–6 — épicos

Detalhadas quando a Onda 1 fechar. Sequência e justificativa em
`ROADMAP_GESTAO_PUBLICA.md`.

### Onda 2 — Núcleo SIAFIC (12-16 sem)

Orçamento (PPA/LDO/LOA, créditos adicionais) · contabilidade PCASP (empenho →
liquidação → pagamento, restos a pagar, encerramento) · tesouraria (OB,
conciliação) · balanços Lei 4.320, DCASP, MSC para o SICONFI. Reusa o workflow de
`payroll_cycles` como motor de documentos contábeis; RLS de verdade nasce aqui.

**O2-01 — Dotação orçamentária (LOA) ✅.** Base do orçamento: `budget_appropriations`
por classificação completa (unidade orçamentária + função/subfunção + programa +
ação + natureza da despesa + fonte), com `valor_orcado`/`valor_empenhado`/saldo e a
invariante `empenhado ≤ orçado` no banco. Permissões `budget.read`/`budget.manage`.
Server functions `getBudgetAppropriations`/`saveBudgetAppropriation` (dedup pela chave
orçamentária; não se orça abaixo do já empenhado). Migration
`20260909120000_o2_01_budget_appropriations.sql`; teste
`tests/sprint-budget-appropriations.test.mjs` verificado por mutação. É a âncora que
a requisição de empenho da folha (O1-08) e o empenho PCASP passarão a reservar.
**O2-02 — Empenho contra dotação (reserva de saldo) ✅.** `budget_commitments`: o
empenho (Lei 4.320 art. 58) referencia uma dotação e RESERVA seu valor no
`valor_empenhado` da dotação, atômico (lock `for update`, nunca acima do saldo),
com numeração sequencial por exercício (contador travado, molde do NSR do ponto).
`createBudgetCommitment`/`getBudgetCommitments`. Migration
`20260909130000_o2_02_budget_commitments.sql`; teste
`tests/sprint-budget-commitment.test.mjs` verificado por mutação.
**O2-03 — Liquidação, pagamento e anulação ✅.** Estágios da despesa (Lei 4.320
arts. 63–64) como máquina de estados sobre `budget_commitments`:
empenhado→liquidado→pago (`transitionBudgetCommitment`, valida o estágio de
origem e carimba o marco), e **anular devolve o saldo** reservado à dotação
(empenho pago não anula). Migration
`20260909140000_o2_03_commitment_stages.sql`; teste
`tests/sprint-budget-stages.test.mjs` verificado por mutação.
Pendente de endurecimento: exigir MFA nas transições financeiras (molde
`requireCriticalMfa` da folha) — registrado.
**O2-04 — Folha → orçamento ✅.** `commitPayrollEmpenho` transforma a requisição
de empenho da folha (O1-08) em empenhos reais contra dotação (O2-02), um por linha
(natureza), reservando saldo; exige alocar toda linha e marca a requisição como
`empenhada` (idempotente). O núcleo de reserva foi extraído em
`reserveOnAppropriation`, reusado pelo empenho manual e pelo da folha. Migration
`20260909150000_o2_04_payroll_empenho_committed.sql`; teste
`tests/sprint-folha-empenho.test.mjs` verificado por mutação.
**O2-05 — Razão contábil (partidas dobradas) ✅.** `accounting_entries`/`_lines`:
todo lançamento tem débito e crédito que se igualam — `postAccountingEntry` recusa
desbalanceado; `getBalancete` devolve saldo por conta e o balancete fecha em zero.
O helper `postEntry(client, …)` é reusado pelos roteiros automáticos. Permissões
`accounting.*`. Migration `20260909160000_o2_05_accounting_ledger.sql`; teste
`tests/sprint-accounting-ledger.test.mjs` verificado por mutação.
**O2-06 — Contabilização automática por fato ✅.** Empenho, anulação, liquidação e
pagamento geram lançamento contábil balanceado no razão (O2-05) na MESMA transação
do fato. Como os códigos PCASP dependem do plano do ente, o roteiro é **configurável**
(`accounting_event_accounts`: conta débito/crédito por evento) — não se fixa código
de memória; sem mapeamento, o fato não contabiliza. `saveAccountingEventAccount` +
`contabilizarEvento`. Migration `20260909170000_o2_06_accounting_event_accounts.sql`;
teste `tests/sprint-accounting-routing.test.mjs` verificado por mutação.
**O2-09 — Restos a pagar (encerramento do exercício) ✅.** No fim do exercício,
`inscribeRestosAPagar` snapshota os empenhos não pagos em `restos_a_pagar`:
liquidados → PROCESSADOS, empenhados → NÃO PROCESSADOS (Lei 4.320 art. 36); pago
e anulado não inscrevem; cada empenho inscreve uma só vez (idempotente).
`payRestoAPagar` quita o resto e o empenho de origem; `getRestosAPagar` lista.
Reusa `budget.*`. Migration `20260909300000_o2_09_restos_a_pagar.sql`; teste
`tests/sprint-restos-a-pagar.test.mjs` verificado por mutação.

**O2-20 — Cancelamento de restos a pagar (Lei 4.320 art. 38) ✅.** `cancelRestoAPagar`
cancela um resto **inscrito** (prescrição/insubsistência): o resto vai a `cancelado` e o
empenho de origem a `anulado` (obrigação extinta), sem devolver saldo à dotação (o
exercício de origem está encerrado); resto pago/cancelado não cancela. Reusa
`budget.manage`, sem migration (o status `cancelado` já existia). Teste
`tests/sprint-restos-cancel.test.mjs` verificado por mutação (aceitar resto não inscrito
derruba).

**O2-21 — Painel de Restos a Pagar (UI) ✅.** Rota `/restos-a-pagar` dá cara ao
O2-09/O2-20: lista os restos inscritos (empenho, exercício, credor, tipo, valor, situação)
com ações "Pagar" e "Cancelar" por resto inscrito e "Inscrever exercício" (snapshot dos
empenhos não pagos). Reusa `getRestosAPagar`, `inscribeRestosAPagar`, `payRestoAPagar`,
`cancelRestoAPagar`; item de menu em Contabilidade e Finanças. Sem novo backend.
**O2-10 — Balanço orçamentário (Lei 4.320, Anexo 1) ✅.** `getBudgetBalance`
consolida o exercício: RECEITA (prevista × arrecadada × diferença), DESPESA
(fixada × empenhada × liquidada × paga × saldo de dotação), o resultado
orçamentário (arrecadada − empenhada: superávit/déficit) e os restos a pagar
inscritos por tipo. Read-only, cada total em consulta própria (sem JOIN, não
infla por fan-out). Reusa `budget.read`, sem migration. Teste
`tests/sprint-budget-balance.test.mjs` verificado por mutação.
**O2-11 — Tesouraria (contas, movimentação, transferência) ✅.**
`treasury_accounts` (caixa/banco do ente) e `treasury_movements`:
`recordTreasuryMovement` (ingresso soma, saída subtrai e **nunca deixa o saldo
negativo**; grava o saldo após), `transferBetweenAccounts` (saída da origem +
ingresso no destino, **atômico**, contas travadas em ordem estável),
`saveTreasuryAccount`/`getTreasuryAccounts`. Base do balanço financeiro e da
conciliação. Reusa `accounting.*`. Migration `20260909360000_o2_11_treasury.sql`;
teste `tests/sprint-treasury.test.mjs` verificado por mutação (permitir saldo
negativo derruba).
**O2-12 — Disponibilidade de caixa (base do balanço financeiro) ✅.**
`getCashAvailability` consolida o saldo das contas ativas de tesouraria e o fluxo
do período: ingressos, saídas, fluxo líquido (ingressos − saídas) e as
transferências internas à parte (que se anulam entre contas). Read-only, reusa
`accounting.read`, sem migration. Teste `tests/sprint-cash-availability.test.mjs`
verificado por mutação (contar saída como ingresso derruba).
**O2-13 — Crédito adicional por remanejamento (Lei 4.320 art. 42-43) ✅.**
`transferBudgetCredit` transfere dotação entre classificações no mesmo exercício:
anula o orçado da origem e suplementa o destino, atômico (contas travadas em
ordem estável); a **origem nunca fica abaixo do já empenhado** e as duas dotações
têm de estar ativas. `budget_credit_movements` guarda a trilha com justificativa;
`getBudgetCreditMovements` lista. Reusa `budget.*`. Migration
`20260909390000_o2_13_budget_credit_transfer.sql`; teste
`tests/sprint-budget-credit.test.mjs` verificado por mutação (ignorar o piso do
empenhado derruba).

**O2-22 — Crédito adicional por excesso de arrecadação (Lei 4.320 art. 43, II) ✅.**
`openSupplementaryCredit` suplementa uma dotação **ativa** lastreado no **excesso de
arrecadação** da fonte (arrecadado − previsto), nunca acima do excesso ainda não
utilizado por créditos anteriores da mesma fonte no exercício; suplementa o destino e
registra o crédito com justificativa. `getSupplementaryCredits` lista. Migration
`..._o2_22_supplementary_credit.sql`, reusa `budget.*`; teste
`tests/sprint-supplementary-credit.test.mjs` verificado por mutação (inverter o teto do
excesso derruba). Próximo (UI): abertura de crédito suplementar no `/orcamento`.

**O2-23 — Contingenciamento / limitação de empenho (LRF art. 9) ✅.**
`contingenciarDotacao` bloqueia parte de uma dotação **ativa** sem alterar o orçado, e o
bloqueio **nunca invade o já empenhado** (empenhado + bloqueado ≤ orçado);
`descontingenciarDotacao` libera sem deixar o bloqueado negativo. O **saldo empenhável**
passa a descontar o bloqueado — tanto em `getBudgetAppropriations` quanto na reserva de
empenho (`reserveOnAppropriation`), então o contingenciamento efetivamente barra novos
empenhos. Migration `..._o2_23_budget_contingency.sql` (ALTER + 2 checks), reusa
`budget.*`; teste `tests/sprint-budget-contingency.test.mjs` verificado por mutação (não
descontar o bloqueado do saldo derruba).

**O2-24 — Contingenciamento e crédito suplementar no `/orcamento` (UI) ✅.** A tela de
orçamento passa a exibir a coluna **Bloqueado** e o saldo empenhável já líquido; cada
dotação ativa tem a ação **Contingenciar** (valor + motivo) e o cabeçalho o botão
**Crédito suplementar** (destino, fonte, valor, justificativa, por excesso de
arrecadação). Reusa `contingenciarDotacao` e `openSupplementaryCredit`. Sem novo backend.

**O2-25 — Balanço financeiro (Lei 4.320 Anexo 13) ✅.** `getFinancialBalance` confronta,
no exercício, os **ingressos** (receita orçamentária arrecadada + inscrição de restos a
pagar, extraorçamentário) com os **dispêndios** (despesa orçamentária paga + pagamento de
restos a pagar, extraorçamentário) e apura o **resultado financeiro**; os restos são
datados por `inscrito_em`/`pago_em`. Read-only, reusa `budget.read`, sem migration; cartões
no `/balancos`. Teste `tests/sprint-financial-balance.test.mjs` verificado por mutação
(somar em vez de subtrair no resultado derruba). Completa o quarteto da Lei 4.320
(orçamentário, financeiro, patrimonial/DVP) no sistema.

**O2-14 — Execução da receita por natureza ✅.** `getRevenueExecution` consolida,
por natureza de receita, previsto × arrecadado × a arrecadar (piso zero) no
exercício — o espelho, do lado da receita, da execução da despesa. Read-only,
reusa `budget.read`, sem migration; teste `tests/sprint-revenue-execution.test.mjs`
verificado por mutação (permitir a_arrecadar negativo derruba).
Próximo: balanço financeiro completo (com receita/despesa orçamentária e
extraorçamentária) e patrimonial, demonstração das variações patrimoniais
(DCASP); ordem bancária (OB) e MSC-SICONFI.

**O2-15 — Conciliação bancária ✅.** `reconcileTreasuryAccount` compara o saldo
contábil (livro) de uma conta de tesouraria com o saldo do extrato numa data e
registra a diferença (extrato − livro), uma por conta/data; `getTreasuryReconciliations`
lista. Trava a conta `FOR UPDATE`, dedup por conta/data, trigger de coerência de ente.
Migration `..._o2_15_treasury_reconciliation.sql`, reusa `accounting.*`; teste
`tests/sprint-treasury-reconciliation.test.mjs` verificado por mutação (inverter o
sinal da diferença derruba). Próximo: ordem bancária (OB) e MSC-SICONFI.

**O2-16 — Ordem bancária (OB) ✅.** `emitBankOrder` liga a execução da despesa à
tesouraria: paga um empenho **liquidado** (Lei 4.320 — só o liquidado paga) por uma
conta, numerando a OB por ente/exercício (linha-contador travada), gerando a saída
bancária (saldo nunca negativo), levando o empenho a `pago` e contabilizando o evento
de pagamento — tudo na mesma transação. Um empenho paga uma só vez (guarda de estágio
+ `unique (tenant, commitment)`). `getBankOrders` lista; UI em `/ordens-bancarias`.
Migration `..._o2_16_bank_orders.sql`, reusa `accounting.*`; teste
`tests/sprint-bank-orders.test.mjs` verificado por mutação (somar em vez de subtrair o
valor no saldo derruba). Próximo: MSC-SICONFI e a demonstração dos fluxos de caixa.

**O2-18 — Balanço patrimonial + DVP (PCASP) ✅.** `getEquityStatement` classifica o
razão (`accounting_entry_lines`) pela classe PCASP — 1 Ativo, 2 Passivo, 3 VPD, 4 VPA
—, inverte o sinal das contas de natureza credora e apura Ativo, Passivo, Patrimônio
Líquido (Ativo − Passivo), VPA, VPD e o resultado patrimonial (VPA − VPD). Read-only,
reusa `accounting.read`, sem migration; cartões no `/balancos`. Teste
`tests/sprint-equity-statement.test.mjs` verificado por mutação (inverter para VPD − VPA
derruba). Próximo: balanço financeiro (Anexo 13) e MSC-SICONFI.

**O2-19 — Cronograma de desembolso ✅.** `saveDisbursementQuota` programa cotas mensais
de desembolso por fonte (upsert por ente/exercício/mês/fonte); `getDisbursementSchedule`
confronta, mês a mês, o programado com o realizado (despesa paga no mês) e apura o saldo
da cota (negativo = estouro) — programação financeira da Lei 4.320 art. 47-50. Migration
`..._o2_19_disbursement_schedule.sql`, reusa `budget.*`; cronograma no `/orcamento`. Teste
`tests/sprint-disbursement-schedule.test.mjs` verificado por mutação (somar em vez de
subtrair no saldo derruba). Próximo: balanço financeiro (Anexo 13) e MSC-SICONFI.

### Onda 3 — Materiais e Contratações (14-18 sem)

Compras Lei 14.133 → contratos → almoxarifado → patrimônio (depreciação NBC TSP)
→ frotas → integração PNCP. Emite empenho pelo mesmo primitivo da folha.

**O3-01 — Contratos administrativos (Lei 14.133) ✅.** `procurement_contracts`:
contrato com fornecedor, objeto, modalidade (pregão, concorrência, dispensa,
inexigibilidade...), valor/vigência, `valor_empenhado` e saldo, com invariante
`empenhado ≤ total`. Permissões `contracts.read`/`contracts.manage`.
`getContracts` (com saldo) e `saveContract` (dedup número/ano; o total não cai
abaixo do já empenhado). Base para almoxarifado, patrimônio e PNCP. Migration
`20260909190000_o3_01_contracts.sql`; teste `tests/sprint-contracts.test.mjs`
verificado por mutação.
**O3-02 — Almoxarifado (estoque de materiais) ✅.** `material_items` (catálogo +
saldo em quantidade/valor) e `material_movements` (entrada/saída).
`recordMaterialMovement`: entrada soma; saída baixa a **custo médio** e nunca
excede o saldo. `getMaterialItems`/`saveMaterialItem`. Permissões
`materials.read`/`materials.manage`. Migration
`20260909200000_o3_02_materials.sql`; teste `tests/sprint-materials.test.mjs`
verificado por mutação.
**O3-03b — Resumo do patrimônio ✅.** `getPatrimonySummary` consolida os bens **ativos**:
quantidade, valor de aquisição, depreciação acumulada e o **valor líquido contábil**
(aquisição − depreciação) — bem baixado não entra no acervo líquido — além da contagem de
baixados. Reusa `assets.read`, sem migration; `/patrimonio` passa a somar pelo servidor
(cartões aquisição, depreciação, líquido e baixados), corrigindo o total que antes incluía
baixados no cliente. Teste `tests/sprint-patrimony-summary.test.mjs` verificado por mutação
(líquido = aquisição ignorando depreciação, ou incluir baixado nos ativos, derruba).

**O3-03 — Patrimônio + depreciação linear (NBC TSP) ✅.** `patrimony_assets`: bem
com aquisição, residual, vida útil e depreciação acumulada. `depreciateAsset`
deprecia linear (cotas constantes); a acumulada nunca passa da base depreciável
(aquisição − residual) e respeita a vida útil (preserva o valor residual).
`getAssets`/`saveAsset`. Permissões `assets.read`/`assets.manage`. Migration
`20260909210000_o3_03_assets.sql`; teste `tests/sprint-assets.test.mjs`
verificado por mutação (remover o cap de meses derruba).
**O3-04 — Contrato → orçamento ✅.** `commitContractEmpenho`
(`budget.functions.ts`) empenha uma parcela do contrato (O3-01) contra dotação,
pelo mesmo primitivo `reserveOnAppropriation` da folha (O2-04) — um contrato
pode ser empenhado em várias parcelas (execuções/exercícios diferentes), nunca
acima do saldo do contrato nem da dotação, e só um contrato **vigente** pode ser
empenhado. `transitionBudgetCommitment` (O2-03) passou a devolver o saldo
reservado também ao contrato — não só à dotação — quando um empenho de origem
`contrato` é anulado. CHECK de origem do empenho ampliado para `'contrato'`.
Migration `20260909220000_o3_04_contract_empenho.sql`; teste
`tests/sprint-contract-empenho.test.mjs` verificado por mutação.
**O3-07 — Termo aditivo de contrato (Lei 14.133, art. 125) ✅.**
`registerContractAmendment` adita o contrato vigente: acréscimo/supressão de
valor (limitado a **25% do valor original, de forma acumulada** entre aditivos)
e/ou prorrogação de vigência; numeração sequencial por contrato, justificativa
obrigatória; supressão não pode deixar o total abaixo do já empenhado. Atualiza
`valor_total`/`vigencia_fim`. `getContractAmendments` lista. Reusa `contracts.*`.
Migration `20260909320000_o3_07_contract_amendments.sql`; teste
`tests/sprint-contract-amendments.test.mjs` verificado por mutação (comparar o
acréscimo isolado, não o acumulado, ao limite derruba).
**O3-08 — Itens do contrato (Lei 14.133) ✅.** `addContractItem` detalha o
contrato em linhas de material/serviço (valor da linha = quantidade × preço
unitário, arredondado), numeração sequencial por contrato; a **soma dos itens
não pode exceder o valor total do contrato** (invariante testado).
`getContractItems` lista. Reusa `contracts.*`. Migration
`20260909340000_o3_08_contract_items.sql`; teste
`tests/sprint-contract-items.test.mjs` verificado por mutação (ignorar a soma
dos itens já lançados no teto derruba).
**O3-08b — Propostas e julgamento por menor preço (Lei 14.133 art. 33-34) ✅.**
`recordProcurementProposal` registra propostas de fornecedores numa licitação **aberta**
(uma por fornecedor/licitação; pode entrar desclassificada com motivo);
`getProcurementJudgment` ordena por menor valor, classifica só as válidas (1, 2, 3…) e a
menor **válida** vence — proposta desclassificada, ainda que a mais barata, não classifica
nem vence. Migration `..._o3_08b_procurement_proposals.sql` (tabela + coerência de ente),
reusa `contracts.*`; `/licitacoes` ganha a ação Propostas (ranking + vencedor + adicionar).
Teste `tests/sprint-procurement-judgment.test.mjs` verificado por mutação (deixar a
desclassificada vencer derruba). Próximo: adjudicação/homologação amarrando o vencedor ao
contrato; PNCP (externo, homologação).

**O3-08c — Adjudicação do vencedor (Lei 14.133 art. 71) ✅.** `adjudicateProcurementWinner`
fixa, numa licitação **homologada**, a proposta de menor valor entre as classificadas e o
`valor_homologado` — exige homologação e ao menos uma proposta classificada; a
desclassificada mais barata não é adjudicada. `getProcurementProcesses` passa a devolver o
vencedor e o valor homologado. Migration `..._o3_08c_procurement_award.sql` (ALTER aditivo
+ FK vencedor), reusa `contracts.*`; `/licitacoes` ganha a ação Adjudicar e o vencedor na
tabela. Teste `tests/sprint-procurement-award.test.mjs` verificado por mutação (adjudicar a
desclassificada, ou adjudicar licitação aberta, derruba). Próximo: amarrar o vencedor
adjudicado ao contrato (O3-09) e à ata de preços; PNCP (externo, homologação).

**O3-09 — Vínculo contrato ↔ licitação (Lei 14.133) ✅.**
`linkContractToProcurement` liga o contrato à licitação de origem
(`procurement_contracts.procurement_process_id` → `procurement_processes`, O3-06);
só uma licitação **homologada**, do mesmo ente e com **modalidade coerente**, pode
originá-lo. Reusa `contracts.*`. Migration
`20260909350000_o3_09_contract_procurement_link.sql` (ALTER aditivo); teste
`tests/sprint-contract-procurement.test.mjs` verificado por mutação (aceitar
licitação não homologada derruba).
Remessa ao PNCP (externo, homologação).

**O3-19 — Incorporação de material permanente ao patrimônio (liga O3-02 ↔ O3-03) ✅.**
`incorporateMaterialAsset` dá baixa da quantidade no almoxarifado **a custo médio** do
saldo e cria o bem patrimonial com `valor_aquisicao` = custo médio × quantidade. Só
material **permanente** com saldo suficiente incorpora; o tombamento não se repete. Exige
`materials.manage` (baixa o estoque) **e** `assets.manage` (cria o bem), numa única
transação. Sem migration (usa as tabelas existentes); `/almoxarifado` ganha a ação
Incorporar nos itens permanentes. Teste `tests/sprint-material-asset-incorporation.test.mjs`
verificado por mutação (usar o saldo total em vez de custo médio × quantidade, ou
incorporar material de consumo, derruba).

**O3-18 — Razão (kardex) de movimentação de material ✅.** `getMaterialLedger` relê as
movimentações do item em ordem cronológica e recompõe o saldo em quantidade linha a linha
(entrada soma, saída subtrai); o saldo corrente final bate com o saldo do próprio item.
Sem migration, reusa `materials.read`; `/almoxarifado` ganha a ação Razão por item.
Teste `tests/sprint-material-ledger.test.mjs` verificado por mutação (inverter o sinal da
saída no saldo corrente derruba).

**O3-17 — Classificação de material + inventário por categoria ✅.** Material ganha
`categoria` (consumo/permanente): consumo baixa por VPD de consumo, permanente tende ao
patrimônio. `getMaterialInventory` totaliza itens e saldos (quantidade/valor) por
categoria, com total geral, considerando só material **ativo**. Migration
`..._o3_17_material_category.sql` (ALTER aditivo + check, default `consumo` preserva o
acervo), reusa `materials.*`; `/almoxarifado` ganha o seletor de categoria, a coluna e os
cartões de inventário. Teste `tests/sprint-material-inventory.test.mjs` verificado por
mutação (somar só uma categoria no total, ou incluir o inativo, derruba).
Próximo: ligar o material permanente adquirido à entrada de bem em patrimônio (O3-03).

**O3-16 — Transição de contrato (Lei 14.133 art. 137-139) ✅.** `transitionContract` move
o contrato pela máquina de estados: vigente ↔ suspenso, e vigente/suspenso →
encerrado/rescindido (terminais); cada ação só vale a partir do estado de origem correto.
Reusa `contracts.manage`, sem migration (o enum de status já existia); ações
Suspender/Retomar/Encerrar/Rescindir no `/contratos`. Teste
`tests/sprint-contract-transition.test.mjs` verificado por mutação (aceitar ação a partir
de estado terminal derruba).

**O3-14 — Medição / recebimento de contrato (Lei 14.133 art. 140) ✅.**
`recordContractMeasurement` registra a medição de um contrato **vigente**, acumulando o
`valor_executado` e numerando por contrato; a execução acumulada **nunca passa do valor
empenhado** (só se liquida o que foi empenhado — Lei 4.320). `getContractMeasurements`
lista. Migration `..._o3_14_contract_measurements.sql` (ALTER aditivo + tabela), reusa
`contracts.*`. Teste `tests/sprint-contract-measurements.test.mjs` verificado por mutação
(usar o valor total em vez do empenhado no teto derruba).

**O3-15 — Medições no painel de contratos (UI) ✅.** No `/contratos`, cada contrato
expande as suas medições (nº, competência, descrição, valor, recebimento) e tem a ação
"Medir" (contrato vigente) que registra uma medição respeitando o teto do empenhado.
Reusa `getContractMeasurements` e `recordContractMeasurement`. Sem novo backend.

**O3-12 — Ata de Registro de Preços (SRP, Lei 14.133 art. 82-86) ✅.**
`createPriceRegistration` forma a ata a partir de uma licitação **homologada**, com itens
(unidade, quantidade registrada, preço) e **vigência de até 1 ano** (art. 84);
`drawFromPriceRegistration` consome do **saldo registrado** (registrada − consumida),
nunca acima, com a ata vigente (status e data); `getPriceRegistrations` lista.
Migration `..._o3_12_price_registration.sql` (2 tabelas), reusa `contracts.*`. Teste
`tests/sprint-price-registration.test.mjs` verificado por mutação (inverter o teste de
saldo no consumo derruba).

**O3-13 — Painel de Registro de Preços (UI) ✅.** Rota `/atas` dá cara ao O3-12: lista as
atas com seus itens (registrada × consumida × saldo), ação "Consumir" por item (respeita o
saldo e a vigência) e "Nova ata" a partir de uma licitação homologada. Reusa
`getPriceRegistrations`, `createPriceRegistration`, `drawFromPriceRegistration`; item de
menu em Contratações. Sem novo backend.

**O3-11 — Baixa / alienação de bem patrimonial ✅.** `disposeAsset` registra a saída
do bem do acervo (alienação, desfazimento, perda) e apura o resultado da baixa = valor
de alienação − valor líquido contábil (aquisição − depreciação acumulada): ganho se
positivo, perda se negativo. Só um bem ativo baixa; a baixa é definitiva (não deprecia
mais). Migration `..._o3_11_asset_disposal.sql` (ALTER aditivo: baixa_em, baixa_motivo,
valor_alienacao, resultado_baixa, baixa_por); reusa `assets.*`; ação "Baixar" no
`/patrimonio`. Teste `tests/sprint-asset-disposal.test.mjs` verificado por mutação
(inverter para líquido − alienação derruba o sinal). Próximo: baixa contabilizada como
VPD/VPA de alienação (evento contábil dedicado) e remessa ao PNCP (externo).

### Onda 4 — Tributação e Receita (14-20 sem)

Cadastros imobiliário/mobiliário · IPTU, ISS, ITBI · dívida ativa (CDA, execução
fiscal) · NFS-e padrão nacional · certidões.

Entregue (base): O4-01 créditos tributários (lançamento, arrecadação, inscrição
em dívida ativa — Lei 6.830); O4-02 parcelamento de dívida ativa (REFIS: rateio
do saldo em N parcelas mensais com soma exata, cada parcela arrecada no crédito,
a última quita crédito e plano; um plano ativo por crédito, reusa `taxes.*`).
O4-03 consulta de regularidade fiscal (base da CND: aponta débitos em aberto —
lançados ou em dívida ativa com saldo — por contribuinte; NÃO emite certidão
oficial, código nem assinatura); O4-04 cadastro imobiliário + IPTU
(`real_estate_properties` com inscrição/proprietário/valor venal/áreas;
`launchIptu` gera o crédito tributário = valor venal × alíquota em `tax_credits`,
um por imóvel/exercício, ligando o cadastro à arrecadação — reusa `taxes.*`).
O4-05 cadastro mobiliário + ISS (`service_taxpayers` com inscrição municipal,
atividade e alíquota; `launchIss` gera o crédito ISS = base × alíquota por
competência em `tax_credits`, inscrição "inscricao/competencia", um por
competência — reusa `taxes.*`); O4-06 ITBI sobre transmissão (`launchItbi`:
crédito = valor da transmissão × alíquota por transmissão, inscrição
"inscricao/ITBI/data", sobre o cadastro imobiliário — reusa `taxes.*`, sem
migration). Trio municipal completo (IPTU/ISS/ITBI + ITBI/taxas) no mesmo fluxo
de arrecadação → dívida ativa → parcelamento. Pendente (externo/homologação): NFS-e padrão
nacional; emissão da CND com autenticação e layout do ente; execução fiscal
integrada ao Judiciário.

**O4-07 — Encargos de mora do crédito tributário ✅.** `getUpdatedTaxDebt` calcula o
valor atualizado do crédito: sobre o saldo devedor (lançado − pago), a partir do
vencimento, aplica multa de mora (uma vez) e juros de mora por mês ou fração (mês
comercial de 30 dias; CTN art. 161 §1º — padrão 1%/mês, multa 2%). É **calculadora
paramétrica** (as alíquotas vêm do ente) e de **previsão** — não grava nem declara
conformidade com código municipal específico. Read-only, reusa `taxes.read`, sem
migration; ação "Atualizar" no `/tributos`. Teste `tests/sprint-tax-mora.test.mjs`
verificado por mutação (ignorar os meses de mora nos juros derruba). Próximo: CDA
numerada e execução fiscal (Lei 6.830).

**O4-13 — Cancelamento de crédito tributário (isenção/anistia/remissão) ✅.**
`cancelTaxCredit` cancela um crédito que **não** esteja quitado nem já cancelado; recusa se
houver **parcelamento ativo** (deve ser rescindido antes, evitando cancelar dívida em
cobrança amigável). Reusa `taxes.manage`, sem migration (o status `cancelado` já existia);
ação "Cancelar" no `/tributos`. Teste `tests/sprint-tax-cancel.test.mjs` verificado por
mutação (aceitar cancelar crédito quitado derruba).

**O4-08 — Certidão de Dívida Ativa (CDA) numerada ✅.** `emitActiveDebtCertificate`
registra a CDA (Lei 6.830 art. 2º) de um crédito já inscrito em dívida ativa: numera por
ente/exercício (linha-contador travada) e fixa o **saldo inscrito** (lançado − pago),
formando o título executivo. Só um crédito em `divida_ativa` com saldo; uma CDA por
crédito (`unique (tenant, credit)` + guarda de estado). É o **registro** da CDA — não
emite documento autenticado, código de validação nem assinatura (isso depende de
homologação/ferramenta do ente). Migration `..._o4_08_active_debt_certificate.sql`, reusa
`taxes.*`; ação "Emitir CDA" no `/tributos`. Teste
`tests/sprint-active-debt-certificate.test.mjs` verificado por mutação (usar o valor
lançado em vez do saldo derruba). Próximo: execução fiscal (ajuizamento) sobre a CDA.

**O4-11 — Rescisão do parcelamento por inadimplência ✅.** `rescindInstallmentPlan`
rescinde o plano **ativo** quando há pelo menos `limite_atraso` parcelas vencidas e não
pagas na data de referência (padrão 3); abaixo do limiar recusa; um plano já
rescindido/quitado não rescinde. O crédito permanece em dívida ativa com o saldo
remanescente (as parcelas pagas já arrecadaram). Reusa `taxes.manage`, sem migration (o
status `rescindido` já existia no enum). Teste `tests/sprint-installment-rescission.test.mjs`
verificado por mutação (inverter o limiar derruba).

**O4-12 — Painel de parcelamentos (UI) ✅.** Rota `/parcelamentos` dá cara ao O4-02/O4-11:
lista os planos (total, parcelas pagas, situação), expande as parcelas de cada acordo com
ação "Pagar" por parcela aberta, "Rescindir" por plano ativo e "Novo parcelamento" a
partir de um crédito em dívida ativa. Reusa `getInstallmentPlans`, `createInstallmentPlan`,
`payInstallment`, `rescindInstallmentPlan` + o novo leitor `getInstallments` (parcelas de
um plano); item de menu em Contabilidade e Finanças.

**O4-09 — Execução fiscal (Lei 6.830) ✅.** `fileFiscalExecution` ajuíza a cobrança de
uma CDA ativa: registra número do processo (informado), data e valor ajuizado (fixado do
valor inscrito na CDA); uma execução por CDA (`unique` + guarda de estado).
`updateFiscalExecutionStatus` move o andamento (ajuizada → suspensa → extinta/quitada) e
trava execuções encerradas; `getFiscalExecutions` lista. É o **registro** interno — não
peticiona nem integra ao Judiciário (integração externa). Migration
`..._o4_09_fiscal_execution.sql`, reusa `taxes.*`. Teste
`tests/sprint-fiscal-execution.test.mjs` verificado por mutação (aceitar CDA não ativa
derruba).

**O4-10 — Painel de Dívida Ativa (UI) ✅.** Rota `/divida-ativa` dá cara ao O4-08/O4-09:
lista as CDAs (nº, exercício, valor inscrito, situação) com ação "Ajuizar", e as
execuções fiscais (CDA, processo, valor, andamento) com transições suspender/quitar/
extinguir. Reusa `getActiveDebtCertificates`, `getFiscalExecutions`,
`fileFiscalExecution`, `updateFiscalExecutionStatus`; item de menu em Contabilidade e
Finanças. Sem novo backend/migration.

**O4-14 — Consolidação de dívida ativa por contribuinte ✅.** `getActiveDebtByTaxpayer`
junta as CDAs ao crédito de origem e agrupa por documento do contribuinte: quantidade,
total inscrito e recorte por situação (ativa/quitada/cancelada); o **saldo em cobrança**
soma SÓ as CDAs `ativa` (quitadas/canceladas não são estoque de dívida). Reusa
`taxes.read`, sem migration; `/divida-ativa` ganha o cartão de saldo em cobrança e a
tabela por contribuinte. Teste `tests/sprint-active-debt-by-taxpayer.test.mjs` verificado
por mutação (somar quitada/cancelada no saldo em cobrança derruba). Próximo: consolidação
da receita de dívida ativa nos balanços.

### Onda 5 — Apoio, controle e transparência (10-14 sem)

Protocolo e processo eletrônico com ICP-Brasil · e-SIC/LAI · controle interno ·
Portal da Transparência (LC 131/2009, dados abertos, acessibilidade).

Entregue (base): O5-01 protocolo/processo eletrônico (numeração sequencial por
ano + tramitação); O5-02 Portal da Transparência (relatório consolidado, LAI);
O5-03 ouvidoria (Lei 13.460 — manifestações denúncia/reclamação/sugestão/elogio/
informação/solicitação, numeração por ano, prazo e ciclo recebida→respondida,
reusa `protocol.*`); O5-04 e-SIC (LAI Lei 12.527 — pedidos de acesso à informação,
prazo de 20 dias prorrogável +10 uma vez, ciclo recebido→prorrogado→respondido/
indeferido, reusa `protocol.*`); O5-05 controle interno (CF art. 74, LRF —
apontamentos de auditoria interna com recomendação/responsável/prazo e
acompanhamento aberto→em_implementacao→implementado/nao_implementado, numeração
por ano, reusa `analytics.*`). Pendente: assinatura ICP-Brasil, dados abertos
publicáveis.

**O5-03b — Painel da ouvidoria (Lei 13.460) ✅.** `getOmbudsmanSummary` consolida as
manifestações **por tipo** (denúncia/reclamação/sugestão/elogio/informação/solicitação),
conta as em aberto (recebida/em_analise), as **vencidas** (em aberto com prazo passado) e a
tempestividade das respondidas (no prazo até o limite; fora depois). Reusa `protocol.read`,
sem migration; `/ouvidoria` ganha os cartões por tipo + em aberto/vencidas/no prazo. Teste
`tests/sprint-ombudsman-summary.test.mjs` verificado por mutação (agrupar tipo errado, ou
contar em aberto no prazo como vencida, derruba).

**O5-04b — Painel de prazos do e-SIC (LAI) ✅.** `getEsicSummary` consolida a contagem por
situação e destaca os pedidos **em aberto** (recebido/prorrogado) com prazo de resposta
vencido, além da **tempestividade** dos respondidos/indeferidos (no prazo quando
respondido até o prazo; fora quando depois — limite `<=`). Reusa `protocol.read`, sem
migration; `/esic` ganha os cartões (pedidos, vencidos em destaque, respondidos no/fora do
prazo). Teste `tests/sprint-esic-summary.test.mjs` verificado por mutação (contar em aberto
no prazo como vencido, ou tratar resposta no limite como fora do prazo, derruba).

**O5-05b — Painel de acompanhamento do controle interno ✅.** `getInternalControlSummary`
consolida a contagem de apontamentos por situação e destaca os **vencidos**: os ainda em
curso (aberto/em_implementacao) com prazo anterior à data de referência — apontamento
encerrado (implementado/nao_implementado) nunca é vencido. Reusa `analytics.read`, sem
migration; `/controle-interno` ganha os cartões (total, em curso, implementados, prazo
vencido em destaque). Teste `tests/sprint-internal-control-summary.test.mjs` verificado
por mutação (contar encerrado vencido, ou ignorar o prazo, derruba).

**O5-01b — Histórico de tramitação do processo ✅.** `getProtocolMovements` devolve o
cabeçalho do processo e o trilho de movimentações em ordem cronológica (mais antiga →
mais recente), com o nome das unidades de origem/destino, e **só do processo pedido**
(isolamento por `process_id`). É a linha do tempo do processo para o detalhe e a
auditoria. Reusa `protocol.read`, sem migration. Teste
`tests/sprint-protocol-movements.test.mjs` verificado por mutação (vazar movimentos de
outro processo, ou remover a ordenação por data, derruba).

**O5-06 — Recurso de e-SIC (LAI art. 15) ✅.** `fileEsicAppeal` interpõe recurso da
negativa de acesso: 1ª instância exige pedido **indeferido**; 2ª instância exige o de
1ª **improvido**; um recurso por pedido/instância. `decideEsicAppeal` decide o recurso
pendente e, se **provido**, reabre o pedido (status volta a `recebido`) para cumprimento;
`getEsicAppeals` lista. Migration `..._o5_06_esic_appeals.sql`, reusa `protocol.*`; ação
"Recorrer" no `/esic`. Teste `tests/sprint-esic-appeals.test.mjs` verificado por mutação
(não reabrir o pedido quando provido derruba).

**O5-06b — Painel de recursos e-SIC (UI) ✅.** O `/esic` ganha a seção **Recursos**: lista
os recursos (pedido, instância, situação, decisão) com ações **Prover/Improver** por
recurso pendente e **2ª instância** quando o de 1ª foi improvido, reusando
`getEsicAppeals`, `decideEsicAppeal` e `fileEsicAppeal`. Sem novo backend.

**O5-07 — Pesquisa de satisfação da ouvidoria (Lei 13.460 art. 23) ✅.**
`rateManifestation` registra a nota (1-5) do cidadão só de manifestação **respondida**,
uma por manifestação; `getOmbudsmanSatisfaction` consolida média, total e distribuição
das notas — indicador de satisfação dos serviços. Migration
`..._o5_07_ombudsman_satisfaction.sql`, reusa `protocol.*`; cartão de satisfação e ação
"Avaliar" no `/ouvidoria`. Teste `tests/sprint-ombudsman-satisfaction.test.mjs` verificado
por mutação (não dividir pela quantidade na média derruba). Próximo: carta de serviços ao
cidadão e painel de recursos do e-SIC.

**O5-08 — Indicador de tempestividade das respostas ✅.** `getResponseTimeliness`
consolida, na ouvidoria e no e-SIC, quantas respostas saíram **no prazo legal** (data da
resposta ≤ prazo) e o percentual — transparência ativa do desempenho (Lei 13.460/LAI).
Read-only, reusa `protocol.read`, sem migration; cartões no `/ouvidoria`. Teste
`tests/sprint-response-timeliness.test.mjs` verificado por mutação (inverter a comparação
de prazo derruba). Próximo: carta de serviços ao cidadão (Lei 13.460 art. 7º).

**O5-09 — Carta de Serviços ao Cidadão (Lei 13.460 art. 7º) ✅.** `saveCitizenService`
mantém o catálogo dos serviços do ente (descrição, requisitos, prazo, canais, taxa; nome
único); `publishCitizenService` só publica um serviço **completo** — com descrição, prazo
> 0 e canais —, despublicar é sempre permitido; `getCitizenServices` lista. Migration
`..._o5_09_citizen_services.sql`, reusa `protocol.*`; rota `/carta-servicos`. Teste
`tests/sprint-citizen-services.test.mjs` verificado por mutação (ignorar a completude ao
publicar derruba). Próximo: painel de decisão de recursos do e-SIC e dados abertos.

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
