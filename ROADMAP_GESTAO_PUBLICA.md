# Evolução do `pontopublico` para Gestão Pública Integrada (ERP público)

## Context

O `pontopublico` (≈28k linhas TS/TSX, ≈3,8k linhas SQL, 41 migrations, 33 rotas, 109 server functions) é hoje um sistema de **RH, folha de pagamento e ponto** para o setor público, construído contra um edital de folha/RH. O backlog original — 22 épicos, 102 pontos — está 92,2% executado tecnicamente.

A análise de quatro editais recentes (CREFITO-8 PE 22/2026, TJBA PE 054/2026, MPAC PE 025/2026 e **Timóteo/MG PE 033/2026**) mostrou que o produto cobre **uma** das nove áreas que um pregão de ERP público exige. O PE 033/2026 é explícito: a plataforma deve cobrir **no mínimo 80%** das exigências do Anexo I, **subcontratação é vedada** (salvo data center), e o acervo a migrar abrange tributação, contabilidade, RH/folha, materiais, protocolo, controle interno, NFS-e e portal da transparência.

Uma auditoria do código feita para este plano encontrou, além da lacuna de escopo, **defeitos bloqueantes na fundação** que seriam multiplicados por nove ao adicionar os domínios novos. Eles estão detalhados abaixo e definem a Onda 0.

**Resultado pretendido:** um ERP de gestão pública integrada tecnicamente apto a passar em prova de conceito e juridicamente apto a ser licitado — sequenciado para que a capacidade de faturar chegue o mais cedo possível.

### Restrição declarada de execução

Execução **solo, com Claude Code**. Isso determina o sequenciamento: incrementos pequenos, verificáveis por script, sem frentes que exijam equipe. Pontos marcados ⚠️ são aqueles em que **pessoas — não código — passam a ser o gargalo**.

---

## Estado real do código

O que a auditoria confirmou, porque o plano depende disso:

**Núcleo defensável (qualidade de produção).** RBAC multi-tenant com papéis temporais e escopo hierárquico por unidade (`supabase/migrations/20260816150000_sprint1_multi_tenant_security.sql`, com trigger anti-ciclo por CTE recursiva); motor de fórmulas AST sem `eval`, com whitelist de 11 variáveis e limites de profundidade (`src/lib/payroll-formula.ts`); ciclo de folha com segregação de funções, lock otimista e checksum da memória de cálculo (`src/lib/payroll-cycle.functions.ts`); aplicador de migrations com ledger, checksum e advisory lock (`scripts/db-migrate.mjs`); `Dockerfile` multi-stage com decisões justificadas.

**Defeitos bloqueantes.**

0. **~~`UPDATE` sem filtro era permitido.~~** ✅ **CORRIGIDO.** O `DELETE` tinha trava para filtro vazio; o `UPDATE` não. Uma chamada sem `.eq()` virava `UPDATE tabela SET ...` sem `WHERE`, reescrevendo todas as linhas de todos os entes. Não era vazamento de leitura — era destruição de dados em massa. Corrigido com teste de mutação em `tests/pgrest-guards.test.mjs`.

1. **Isolamento de tenant furado.** `src/lib/pgrest.server.ts` não contém **uma única ocorrência** da palavra `tenant` (verificado), e expõe 13 tabelas legadas — entre elas `unidades`, `profiles`, `time_entries` e `payroll_periods` — com autorização por papéis globais. Um usuário `isRh` de um ente enxerga unidades de todos os entes. **Reproduzido em banco vivo:** com `relforcerowsecurity = false` e a aplicação conectando como dono das tabelas, uma consulta a `unidades` devolveu linhas de dois entes distintos.

1b. **A ponte legada é escalação de privilégio entre entes.** `loadAccess` lê `user_roles` sem noção de tenant e `loadTenantAccess` concede as 52 permissões a quem for `admin` legado. Vetor: um usuário com `role='admin'` global que seja membro de outro ente **como simples funcionário** vira administrador pleno daquele ente. É o caminho normal de qualquer usuário criado via `ADMIN_EMAILS`.

1c. **`time_entries` aceita `user_id` arbitrário.** Para quem tem `manage_employees`, `policyFor` não força `user_id`. Combinado com a policy `te_rh_delete`, o ponto é gravável e apagável arbitrariamente sem rastro. Documentado por teste em `tests/pgrest-guards.test.mjs`, a ser invertido quando o ponto ganhar valor probatório.
2. **RLS inerte.** As policies existem e são boas, mas a aplicação nunca faz `SET ROLE` nem `set_config('request.jwt.claim.sub', ...)`; o pool conecta como dono das tabelas. A autorização real é 100% aplicacional e **fail-open por omissão**: esquecer `requireTenantPermission` num handler novo abre o tenant inteiro.
3. **Ponte legada de permissões.** `src/lib/tenant-access.server.ts:106-189` concede as 52 permissões a quem tem `role='admin'` no modelo antigo, contornando todo o RBAC do banco.
4. **Sem MFA.** Nenhum segundo fator para permissões de criticidade `critica` (`payroll.cycles.close`, `security.manage`, `tenant.manage`).
5. **Três módulos são fachada.** `esocial.functions.ts` marca eventos como assinados sem assinar e não gera XML; `official-export.functions.ts` devolve o **mesmo CSV de 5 colunas** para TCE-CE, SIOPE e MAND; `bank-remittance.functions.ts` grava `layout_version='CNAB240-v1'` e produz linhas de **47 caracteres** (verificado) onde o CNAB 240 exige registros de 240 posições com header de arquivo, header de lote, segmentos e trailers. Nenhum dos três tem tela — são backends órfãos.
6. **Motor não expressa tabela progressiva.** A AST não tem condicionais nem comparadores; INSS/IRRF progressivos são matematicamente impossíveis nela. O cálculo real vive fora do motor, e `payroll_config` é singleton **sem `tenant_id` e sem vigência** — faixas de 2025 hardcoded como DEFAULT.
7. **RPPS inexistente** (zero ocorrências). Para folha pública, é ausência estrutural.
8. **Ponto sem valor probatório.** Sem NSR, AFD, AEJ ou REP-P; RH pode **deletar batidas sem trilha**; `time_entries` está fora do multi-tenant; feriado é calculado como `date.getDay()===0`.
9. **Ilhas desconectadas.** `payroll_monthly_variables` é gravada pela importação e **nunca lida**; o ponto não alimenta a folha (horas e dias são digitados à mão).
10. **Duas gerações coexistindo.** `profiles` vs `persons`+`employment_links`; `payroll_periods` vs `payroll_cycles`; duas telas de folha no menu sem indicar qual vale.
11. **Auditoria em 9 de 24 módulos**, sem triggers, sem helper compartilhado. Remessa bancária, exportação oficial, eSocial e migração histórica não são auditados — exatamente as operações que um TCE pediria em trilha.
12. **Testes bimodais e sem CI.** Sprints 1-7 têm testes reais em PGlite com casos negativos; Sprints 8-20 são `String.includes()` sobre o código-fonte. Não há `.github/`. **As 41 migrations nunca foram aplicadas num banco real.**

---

## A âncora arquitetural: SIAFIC

A decisão mais importante do plano é regulatória, não de stack.

O **Decreto 10.540/2020** obriga cada ente a manter um **SIAFIC** — sistema único e integrado de execução orçamentária, financeira e contábil — com **base de dados única** e ponto único de entrada, compartilhado entre Executivo, Legislativo e RPPS. É por isso que ERPs municipais são vendidos em bloco: orçamento, contabilidade e tesouraria não podem, por lei, ser sistemas separados de fornecedores diferentes.

Consequências para o roadmap:

- O **núcleo SIAFIC** (Orçamento + Contabilidade PCASP + Tesouraria) é o centro gravitacional. Sem ele há um conjunto de acessórios, não um ERP.
- Folha, Compras e Tributação são **sistemas estruturantes**: alimentam o SIAFIC via empenho e via receita arrecadada.
- Por isso a folha precisa ganhar **cedo** a interface de empenho — ainda na Onda 1, antes de a contabilidade existir — para que o modelo de dados nasça correto.

### As nove áreas

| # | Área | Situação | Papel |
|---|---|---|---|
| 1 | Planejamento e Orçamento (PPA, LDO, LOA, créditos adicionais) | 🔴 inexistente | núcleo SIAFIC |
| 2 | Contabilidade PCASP (empenho→liquidação→pagamento, restos a pagar, balanços) | 🔴 inexistente | núcleo SIAFIC |
| 3 | Tesouraria (contas, OB, conciliação, fluxo de caixa) | 🟡 só remessas | núcleo SIAFIC |
| 4 | Tributação e Receita (IPTU, ISS, ITBI, dívida ativa, NFS-e) | 🔴 inexistente | estruturante |
| 5 | **RH, Folha e Ponto** | 🟢 base sólida | estruturante |
| 6 | Materiais (Lei 14.133, contratos, almoxarifado, patrimônio, frotas, PNCP) | 🔴 inexistente | estruturante |
| 7 | Protocolo e Processo Eletrônico (+ e-SIC/LAI) | 🔴 inexistente | apoio |
| 8 | Controle Interno | 🟡 só trilha técnica | apoio |
| 9 | Portal da Transparência (LC 131/2009, dados abertos) | 🔴 inexistente | apoio |

### Obrigações acessórias transversais

SICONFI (MSC, RREO, RGF, DCA) · **TCE estadual** (layout próprio por estado) · PNCP · SIOPE/SIOPS · eSocial/EFD-Reinf/DCTFWeb · NFS-e padrão nacional · Portaria MTP 671/2021 · ICP-Brasil.

**Decisão: qual TCE primeiro.** O código já tem exportações rotuladas TCE-CE; o edital de referência é SICOM/MG. Suportar os dois dobra o custo de conformidade. **Recomendação:** um layout de referência por vez, disparado por oportunidade concreta — nunca especulativamente.

---

## Roadmap

Seis ondas, sequenciadas por **tempo até receita**. A Onda 1 existe para gerar o primeiro atestado o quanto antes; sem ele, todo o resto é investimento sem porta de entrada.

### Onda 0 — Saneamento da fundação `bloqueante`

*Adicionar oito domínios sobre esta base multiplicaria a dívida por oito. Nada da Onda 2 em diante deve começar antes daqui.*

1. ✅ **Aplicar as migrations num banco real.** *Feito.* As 40 migrations aplicaram em PostgreSQL 16 real sem falha: 71 tabelas em `public`, 4 em `analytics`, 2 em `private`, 126 policies, 36 funções, 50 permissões, 4 papéis-sistema. Reaplicação idempotente. Também corrigido: o lockfile estava dessincronizado e `npm ci` abortava — ou seja, **o `Dockerfile` não construía**.
2. **Fechar o furo de tenant.** A saída de menor dívida e sem tocar em nenhuma das 10 telas legadas: mover a decisão de tenant do chamador para o compilador de query. `QueryReq` ganha `tenant_id` obrigatório, o `QueryBuilder` o injeta a partir do tenant ativo que `auth-context.tsx` já mantém, e `dbQuery` passa a chamar `loadTenantAccess` (que já rejeita quem não tem membership). Substituir `ALLOWED_TABLES: Set<string>` por um registro com **união discriminada** — `{strategy:"direct", column:"tenant_id"}` para `unidades`, `{strategy:"via_member", column:"user_id"}` para as demais — de modo que **uma tabela nova sem estratégia declarada não compile**. É a diferença entre lembrar de filtrar e não conseguir esquecer.
2b. **Corrigir na mesma passada:** forçar `user_id` no insert de `time_entries` (defeito 1c) e o operador `is`, que gera `IS $1` — SQL inválido para valor não-nulo.
3. **Tornar a autorização fail-closed — sem ativar RLS agora.** Ativar RLS de verdade exigiria `SET ROLE`/`set_config` por requisição, escopados à sessão do client; como `db.server.ts` expõe `query()` no nível de módulo sobre um pool, isso obrigaria a reescrever as **109 server functions** para receberem um client. Maior refatoração possível, risco alto, zero funcionalidade nova. Em vez disso: um invólucro `withTenant(permission, handler)` obrigatório, um teste de CI que falhe se um `createServerFn` não referenciar `loadTenantAccess` sem estar em allowlist comentada, e conectar o pool com um role **não-dono e sem BYPASSRLS**, o que transforma "esqueci de filtrar" em erro de permissão em vez de vazamento. **A Onda 2 nasce com RLS real**, escrita contra `current_setting('app.tenant_id')` em vez do `auth.uid()` herdado do Supabase — lá não há chamador legado e o custo desaparece.
4. **Aposentar a ponte legada** de `tenant-access.server.ts:106-189`, migrando os papéis antigos para atribuições reais no RBAC.
5. **MFA (TOTP)** obrigatório para permissões de criticidade `critica`.
4b. **Aposentar a ponte em quatro passos, nunca de uma vez:** migration que materializa cada regra hardcoded como papel real; flag `LEGACY_ROLE_BRIDGE` com telemetria em `audit_events` registrando toda vez que a ponte for a **única** origem de uma permissão; virar para `off`; só então deletar as linhas 106-189. Último consumidor a migrar: `AppShell.tsx`, que ainda decide menu por `isAdmin`/`isRh` legados.

5b. **MFA com retorno desproporcional:** `security_permissions.criticidade` já existe com os valores `normal|sensivel|critica`. Basta `requireTenantPermission` consultar a criticidade e exigir `mfa_verified_at` recente quando for `critica`. Uma mudança em uma função cobre as 5 permissões críticas de hoje **e todas as futuras** — emissão de empenho, ordem bancária, encerramento de exercício. TOTP são ~80 linhas com `node:crypto`, e `input-otp` já é dependência.

6. **Auditoria com helper compartilhado**, cobrindo as operações de saída de dados hoje descobertas. Para as tabelas do SIAFIC, adicionalmente **triggers no banco**: em contabilidade, trilha contornável por código futuro não serve.
7. ✅ **CI mínimo.** *Feito.* Cinco jobs, todos verificados verdes localmente antes do commit: catraca de qualidade, dry run em PGlite, **migrations em PostgreSQL 17 real com reaplicação idempotente**, testes e build de produção com verificação do servidor Nitro emitido. Como o baseline é de 274 erros de tipo e 2022 de lint, o gate é uma **catraca** (`scripts/quality-ratchet.mjs`): fixa o número atual como teto e falha se subir — pipeline permanentemente vermelho não é gate, é ruído. Falta converter os validadores de grep das Sprints 8-20 em testes reais, reaproveitando o padrão das Sprints 1-7 e o harness de `tests/pgrest-guards.test.mjs`.
8. **Unificar as duas gerações — separando semanticamente, não fundindo.** `profiles` é referenciada por `app_users`, `security_user_roles`, `audit_events.actor_id`, `tenant_memberships` e `payroll_cycles.prepared_by`; fundir identidade em `persons` seria cascata por todo o esquema de segurança. Declarar três papéis distintos: `profiles` = identidade de login, `persons` = registro civil, `employment_links` = o vínculo. E **`payroll_periods` não migra: congela** — o grão é diferente (usuário/mês com horas vs. competência com resultado por vínculo), converter inventaria dados. Copiar para `historical_records` (a tabela da Sprint 20 existe para isso) e remover `/rh/folha` do menu. **Duas telas de folha inviabilizam qualquer demonstração de PoC**: o avaliador pergunta qual vale, e a resposta correta destrói a credibilidade.
9. ✅ **Decidir sobre os três módulos-fachada.** *Feito* — ver abaixo.

**Prioridade fora de ordem, de 30 minutos:** derrubar a policy `te_rh_delete` e o caminho de delete de batidas, trocando por `deleted_at` + motivo + `audit_events`. Batida apagável sem rastro reprova avaliação técnica independentemente do peso do módulo de ponto no edital.

**Adiado com razão declarada:** Portaria 671/AFD/AEJ (módulo isolado, não multiplica defeito, 3-4 semanas) · ETL incremental do data mart (full-refresh serve até ~100k linhas/mês) · reformatar as migrations minificadas (o ledger tem checksum por arquivo; editar quebra instalações existentes — o lint impede as novas) · catálogo semântico (só se paga com muitos domínios) · RLS nas tabelas legadas (quando forem aposentadas).

> ✅ **Risco jurídico imediato — resolvido.** Manter um módulo rotulado `CNAB240-v1` que não é CNAB 240, e exportações "TCE-CE/SIOPE/MAND" que são o mesmo CSV genérico, é perigoso num certame: o CREFITO-8 exige declaração formal de conformidade integral (item 8.4.3) e Timóteo exige cobertura mínima de 80% (cláusula 9.4). Os rótulos passaram a `RASCUNHO_*`, o eSocial deixou de marcar eventos como assinados sem assinar, e `src/lib/conformance.ts` registra o status e as pendências de cada artefato.

**O que fazer com cada um, e o custo real:**

| Módulo | Decisão | Custo | Por quê |
|---|---|---|---|
| **CNAB 240** | **Implementar de verdade, um banco, na Onda 1** | 6-8 dias | É o mais barato dos três e o de maior alavancagem: a folha fechada já existe, e "gera arquivo de crédito no layout FEBRABAN" é item pontuável e **verificável** — o avaliador abre o arquivo e confere posições. Arquitetar como `src/lib/cnab/` com descritores de campo declarativos e um `writer` **puro** (testável sem banco). **Incluir o parser de retorno**: é ele que sustenta "conciliação bancária" e vira insumo direto da Tesouraria na Onda 2. |
| **Exportações oficiais** | Remover o multiplexador; reconstruir como motor declarativo na Onda 2 | 4-8 semanas, só depois do núcleo contábil | Há um **erro de alvo**: a referência é Timóteo/**MG**, logo o tribunal é **SICOM/TCE-MG**, não TCE-CE. E os arquivos do SICOM são majoritariamente orçamentários e contábeis — gerá-los de `payroll_cycle_results` é impossível por construção, os dados não existem ainda. O `schema_definition` já é `jsonb`: vira descritor real interpretado pelo **mesmo writer posicional do CNAB**. Um motor, três consumidores. |
| **eSocial** | **Declarar não atendido** | 3-6 meses + HSM para A3 | Exige XML validado por XSD, assinatura XMLDSig com ICP-Brasil, transmissão com polling de protocolo e ordenação de eventos (S-1000 → S-1005 → S-2200 → S-1200). **Não é tarefa solo.** O edital veda subcontratação, então "atendido via terceiro" não é opção. A jogada honesta é declarar não atendido e gastar os pontos em Contabilidade e Controle Interno, onde o custo por ponto é uma ordem de grandeza menor. |

### Onda 1 — Tornar RH/Folha/Ponto vendável

*Objetivo: primeiro contrato → primeiro atestado de capacidade técnica.*

- **Tabelas fiscais como entidade de primeira classe + exatamente UM nó novo na AST.** A alternativa — uma flag `calculation_kind='inss'` com código hardcoded — funciona para INSS e IRRF federais e **quebra no RPPS**, porque cada ente tem alíquotas definidas em lei municipal: cada município novo viraria um deploy. Em vez disso, `fiscal_tables` + `fiscal_table_versions` (reusando o vocabulário de ciclo de vida de `payroll_rubric_versions`, que já tem `status='publicada'`, vigência e checksum, com resolução já testada) e um nó `{type:"table_lookup", table:"INSS_FEDERAL", mode:"progressive", base:<ast>}`. As propriedades que preservam a segurança: `table` é **um código, não dados** — a AST nunca contém alíquota; **zero I/O no avaliador** — as tabelas chegam pré-carregadas como `Map`, igual às variáveis hoje, mantendo `payroll-formula.ts` uma função pura; zero operadores novos; faixas limitadas por CHECK. O motor fica fechado e os dados abertos, que é a propriedade que um ERP multi-município precisa. O id **e o checksum** da versão de tabela vão para a memória de cálculo — é o que torna o número defensável perante o TCE.
- **Aposentar `payroll_config`** (singleton sem `tenant_id` e sem vigência, faixas de 2025 como DEFAULT de coluna): migration lê a linha atual e cria `INSS_FEDERAL` e `IRRF_FEDERAL` vigentes de 2025-01-01. Publicação de tabela fiscal é permissão de criticidade `critica` → exige MFA.
- **RPPS vira configuração, não código**: `pension_regimes` por ente + `employment_links.pension_regime_id`; contribuição do servidor, alíquota patronal e contribuição de inativos são rubricas cujas fórmulas fazem `table_lookup` contra a tabela do ente. É o único jeito de atender N municípios.
- **CNAB 240 real** (ver tabela acima), incluindo o parser de retorno.
- **Ponto conforme Portaria MTP 671/2021**: NSR, AFD, AEJ, espelho de ponto, comprovante ao trabalhador, marcações imutáveis com encadeamento, tabela de feriados, tolerância legal, banco de horas. Trazer `time_entries` para dentro do multi-tenant.
- **Ligar as ilhas**: o ponto passa a alimentar a folha; `payroll_monthly_variables` passa a ser lida.
- **Rescisão e férias corretas** (hoje ambas são aritmética simplificada, sem INSS/IRRF).
- **eSocial de verdade**: geração de XML a partir dos dados, assinatura com certificado, transmissão e tratamento de retorno.
- **Interface de empenho da folha** — prepara o SIAFIC e evita retrabalho na Onda 2.

### Onda 2 — Núcleo SIAFIC

- **Orçamento**: PPA, LDO, LOA, programas/ações/metas, créditos adicionais, programação financeira.
- **Contabilidade PCASP**: plano de contas, lançamentos por evento, ciclo **empenho → liquidação → pagamento**, restos a pagar processados e não processados, encerramento de exercício.
- **Tesouraria**: contas, ordem bancária, conciliação, retenções.
- **Relatórios legais**: Anexos da Lei 4.320/1964, DCASP, RREO, RGF, MSC para o SICONFI.

**Modelagem do ente.** O SIAFIC é compartilhado entre Executivo, Legislativo e RPPS. Isso mapeia sobre `tenants` com um nível acima: `tenants.parent_tenant_id` + `tenants.tipo in ('ente','executivo','legislativo','rpps','autarquia','fundo')`, com trigger anti-ciclo espelhando `validate_unidade_tree()`, que já resolve exatamente esse problema. Consolidação vira CTE recursiva; o RBAC não muda uma linha. **RPPS não é onda: é tenant irmão dentro da Onda 2.**

**Saldos são VIEW, não tabela.** `dotação inicial + suplementações − anulações − empenhado − liquidado − pago` derivado em vez de armazenado elimina a classe inteira de bugs de drift de saldo, que é o defeito clássico de sistema contábil. Materializar só se um workload real provar lentidão.

**Reaproveita quatro propriedades já resolvidas em `payroll-cycle.functions.ts`**, extraídas para `document-workflow.server.ts`: máquina de estados declarativa (o `transitionRules` generaliza — empenho, liquidação e OB viram ~30 linhas de declaração cada sobre um motor auditado); lock otimista com `expected_version` + `FOR UPDATE`; segregação de funções (quem ordena a despesa ≠ quem liquida ≠ quem paga); e evento imutável com checksum. Mais o painel LRF/RCL da Sprint 17, que passaria a ler da contabilidade real.

**Ponto único de entrada, mecânico e não declaratório.** O art. 3º do Decreto 10.540 se atende por estrutura: nenhuma server function insere em `accounting_entries`; o único caminho é `postDocument()` lendo `accounting_posting_rules`. Reforço no banco: `REVOKE INSERT` do role da aplicação, expondo só uma função `SECURITY DEFINER`. **Trigger obrigatória**: Σdébitos = Σcréditos por lançamento — é o único lugar do sistema onde constraint de banco supera lógica de aplicação, e não é negociável.

**Como a folha emite empenho.** A transição `close` de `payroll_cycles` passa a chamar `emitPayrollCommitments` **na mesma transação**: agrupa resultados por (unidade orçamentária, natureza de despesa, fonte), faz `SELECT ... FOR UPDATE` na dotação — é ali que mora a race condition clássica —, e cria empenho e liquidação. **Se faltar dotação, o ciclo não fecha.** Atomicidade com o `close` é o que separa integração real de relatório bonito. Compras emite empenho pelo mesmo primitivo na Onda 3.

Com contas PCASP marcadas por atributo (P/F/C) e indicador de superávit financeiro, os Anexos da Lei 4.320 e a DCASP viram **consultas**, não código.

### Onda 3 — Materiais e Contratações (Lei 14.133 + PNCP)

PCA, DFD, ETP, Termo de Referência · processo licitatório, contratos, aditivos, fiscalização · almoxarifado · patrimônio com depreciação e reavaliação (NBC TSP) · frotas · **integração PNCP**. Fecha o ciclo com o SIAFIC: a contratação gera o empenho.

### Onda 4 — Tributação e Receita

Cadastros imobiliário, mobiliário e rural · lançamento de IPTU, ISS, ITBI e taxas · DAM, carnê, parcelamento · **dívida ativa** (inscrição, CDA, execução fiscal) · **NFS-e padrão nacional** · certidões. A receita arrecadada fecha o outro lado do ciclo orçamentário.

### Onda 5 — Apoio, controle e transparência

Protocolo e processo eletrônico com assinatura ICP-Brasil · e-SIC/LAI e ouvidoria · controle interno (plano de auditoria, achados, recomendações) · **Portal da Transparência** com dados abertos, API pública e acessibilidade (eMAG/WCAG).

Depende das ondas anteriores: um portal da transparência sem contabilidade e sem contratações não tem o que publicar.

### Onda 6 — Conformidade contínua e operação ⚠️

Layout do TCE estadual (um projeto por estado) · manutenção legal permanente (a cláusula 9.3 do PE 033 obriga acompanhar toda alteração normativa sem interrupção).

⚠️ **Aqui o gargalo deixa de ser código.** Suporte 8h–12h / 13h30–18h com pessoal capacitado, NOC 24×7, enlaces redundantes com múltiplos provedores, grupo gerador, capacitação presencial em 90 dias e migração de bases legadas de terceiros são exigências contratuais típicas que **não são executáveis solo**. Um contrato de ERP municipal completo não é assinável por uma pessoa, por melhor que seja o software. O caminho realista é entrar por contratos de módulo isolado (folha/ponto) enquanto a estrutura operacional não existe.

---

## Trilha paralela — Habilitação para licitar

Roda junto com as ondas, não depois delas.

**Conformidade documental** — RIPD e política interna de tratamento; termo de sigilo e cláusulas de operador LGPD; comprovação de hospedagem e tratamento em território nacional; plano de resposta a incidentes.

**Habilitação da empresa** — enquadramento ME/EPP; qualificação econômico-financeira com **LC, SG e LG > 1** (exigida em três dos quatro editais analisados); SICAF; certificado ICP-Brasil; cadastro no PNCP.

**O primeiro atestado — o gargalo real.** Nenhum dos quatro editais dispensa atestado de capacidade técnica. O caminho usual é uma primeira contratação de baixo valor via dispensa (art. 75 da Lei 14.133/2021, cujos limites são atualizados anualmente por decreto) num órgão pequeno — conselho profissional, câmara municipal, consórcio intermunicipal — executada com o escopo da Onda 1. O objetivo dessa venda não é margem: é o atestado.

---

## Verificação

Cada onda só se considera concluída com evidência executável, não com código escrito — foi exatamente essa distinção que produziu o "92,2%" enganoso.

**Gate permanente (toda mudança):** `npm run lint`, `npm run typecheck`, `npm run db:dryrun` e a suíte de testes, rodando em CI. Nenhum merge sem os quatro verdes.

**Onda 0:** banco limpo subido via `docker compose`, 41 migrations aplicadas por `npm run db:migrate`, `npm run db:status` sem pendências. Teste automatizado que cria dois tenants, um usuário em cada, e prova que nenhum caminho — inclusive `dbQuery`/`pgrest` — devolve dado do outro. Teste que detecta handler sem `requireTenantPermission`. Login com TOTP exigido em operação crítica.

**Onda 1:** folha de uma competência real calculada ponta a ponta com memória de cálculo conferível; AFD e AEJ gerados e validados por ferramenta oficial; evento eSocial assinado e transmitido em ambiente de homologação da Receita, com recibo; conferência manual de uma rescisão e de umas férias contra cálculo feito à mão.

**Onda 2:** um exercício orçamentário completo simulado — LOA aprovada, empenho emitido pela folha, liquidação, pagamento, restos a pagar, encerramento — com os balanços da Lei 4.320 fechando e a MSC aceita pelo validador do SICONFI.

**Ondas 3–5:** cada integração externa (PNCP, NFS-e, TCE) validada contra o ambiente de homologação do próprio órgão, nunca contra mock próprio. Foi a ausência disso que produziu os três módulos-fachada.

**Regra geral:** nenhum módulo entra em declaração de conformidade de edital antes de ter sido aceito pelo sistema oficial correspondente.

---

## Estimativa

Premissa: solo com Claude Code, ~30 horas produtivas por semana.

| Onda | Semanas | Justificativa da posição |
|---|---|---|
| 0 — Saneamento | **4-6** | Bloqueante; parcialmente feito |
| 1 — Motor fiscal + RPPS + ponto↔folha + CNAB real | **5-7** | Receita mais cedo: a folha é vendável sozinha |
| 2 — SIAFIC | **12-16** | **Tudo** posta nele |
| 3 — Materiais / PNCP | **14-18** | Gera empenho para o que não é folha. Ordem interna: compras → contratos → almoxarifado → patrimônio → frotas → PNCP |
| 4 — Tributação | **14-20** | Menor reuso por esforço: cada Código Tributário Municipal é diferente |
| 5 — Protocolo | **6-8** | Construído antes de existirem processos, vira arquivo genérico |
| 6 — Controle interno | **4-6** | É leitor puro: alto valor de edital, risco baixo |
| 7 — Transparência | **4-6** | Publica tudo; feito antes, refaz-se |

**Total: 63-87 semanas ≈ 15 a 21 meses solo.**

### Os três limiares em que pessoas viram o gargalo

Eles não chegam juntos:

1. **Conhecimento de domínio — início da Onda 2, parcialmente coberto.** PCASP, Lei 4.320 e DCASP estão cobertos pela sua própria formação — caso raro em que esse gargalo é adiado. Mas os layouts do TCE e o plano de contas do município exigem validação por um contador *daquele município*. **É preciso uma prefeitura parceira de homologação desde o início da Onda 2**; sem ela, a Onda 2 produz código que nunca encontrou um balancete real, e a descoberta acontece na demonstração.
2. **Suporte e implantação — na PRIMEIRA venda, não na décima.** Uma pessoa não constrói a Onda 3 e atende uma prefeitura no fechamento do mês ao mesmo tempo: o fechamento não espera. Mínimo viável: um implantador com formação contábil.
3. **Homologação por terceiros — Onda 4.** NFS-e e PNCP exigem credenciamento e testes contra ambientes governamentais. São limitados por **calendário, não por esforço** — não comprimem com mais horas.

### A leitura honesta sobre o PE 033/2026

Chegar a 80% de um ERP público completo solo, no prazo do edital, não é realista — e planejar como se fosse é a decisão que custa mais caro. Duas versões do jogo:

- **Se o alvo é aquele edital:** escopar a PoC em Ondas 0-2 + Onda 6 (barata e pontua bem) e aceitar eSocial, NFS-e e parte de Materiais como não atendidos. Fazer a conta de pontos do TR **antes** de decidir concorrer.
- **Se o alvo é receita:** Ondas 0 e 1 produzem uma folha para município com RPPS, trilha auditável, tabelas fiscais versionadas e remessa CNAB 240 real — **vendável sozinha em 9 a 13 semanas**, sem depender de nada da Onda 2. É o caminho que financia o resto, e o que eu priorizaria.

## Riscos

| Risco | Mitigação |
|---|---|
| Declarar conformidade com base em módulo-fachada | Renomear e marcar como não-conforme **agora** (Onda 0, item 9) |
| Escopo de ERP completo excede capacidade solo | Vender módulo isolado (folha/ponto) enquanto a operação não existe |
| Um TCE por estado multiplica o custo | Um layout por vez, disparado por oportunidade concreta |
| Repetir o padrão "código escrito ≠ sistema funcionando" | CI obrigatório e verificação contra sistema oficial, nunca mock |
| Onda 0 parecer investimento sem retorno visível | É pré-requisito de venda: nenhum dos defeitos passa numa auditoria de PoC |
