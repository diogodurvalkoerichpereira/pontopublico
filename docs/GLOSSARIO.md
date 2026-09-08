# Glossário

Termos de contabilidade pública e de folha que o sistema usa, para quem não vem
da área. Quando o termo tem tabela correspondente, ela está indicada.

## Ciclo orçamentário e da despesa

- **PPA** — Plano Plurianual. Planejamento de 4 anos: programas e metas.
- **LDO** — Lei de Diretrizes Orçamentárias. Anual; liga o PPA à LOA.
- **LOA** — Lei Orçamentária Anual. O orçamento do exercício: quanto cada órgão
  pode gastar, por natureza e fonte.
- **Dotação** — o valor autorizado na LOA para uma finalidade específica. Uma
  linha do orçamento.
- **Crédito adicional** — reforço ou abertura de dotação durante o ano
  (suplementar, especial, extraordinário).
- **Empenho** — primeiro estágio da despesa: reserva da dotação para um credor.
  "Comprometi este dinheiro." Nada é pago sem empenho prévio.
- **Liquidação** — segundo estágio: o órgão verifica que o bem/serviço foi
  entregue e o valor é devido. "Confirmei que recebi."
- **Pagamento** — terceiro estágio: a saída do dinheiro, via **ordem bancária
  (OB)**. "Paguei."
- **Restos a pagar** — despesas empenhadas num exercício e não pagas até 31/12.
  Processados (já liquidados) e não processados (ainda não).

## Contabilidade

- **PCASP** — Plano de Contas Aplicado ao Setor Público. O plano de contas único
  padronizado pela STN, com atributos (P/permanente, F/financeiro, C/controle).
- **Lei 4.320/1964** — a lei geral de orçamento e contabilidade pública; define
  os balanços (orçamentário, financeiro, patrimonial).
- **DCASP** — Demonstrações Contábeis Aplicadas ao Setor Público.
- **Natureza de despesa** — classificação do gasto (pessoal, material, obra…) em
  código de 8 dígitos.
- **Fonte de recurso** — de onde vem o dinheiro (recursos próprios, transferência
  da União, convênio…). Amarra receita a despesa.

## Órgãos de controle e obrigações

- **SIAFIC** — Sistema Único e Integrado de Execução Orçamentária, Administração
  Financeira e Controle (Decreto 10.540/2020). Exige base de dados **única** para
  orçamento, contabilidade e tesouraria. É por isso que ERP público é vendido em
  bloco.
- **SICONFI** — sistema da STN que recebe as declarações contábeis:
  - **MSC** — Matriz de Saldos Contábeis (mensal).
  - **RREO** — Relatório Resumido da Execução Orçamentária (bimestral).
  - **RGF** — Relatório de Gestão Fiscal (quadrimestral).
  - **DCA** — Declaração de Contas Anuais.
- **TCE** — Tribunal de Contas do Estado. Cada um tem seu layout de prestação de
  contas: **SICOM** (MG), **AUDESP** (SP), **SIM-AM** (PR), **e-Contas** (CE)…
- **PNCP** — Portal Nacional de Contratações Públicas. Publicação obrigatória das
  contratações (Lei 14.133).
- **LRF** — Lei de Responsabilidade Fiscal (LC 101/2000). Limita gasto com
  pessoal e endividamento. Ver `fiscal_limit_configs` (tela `/gestor/lrf`).
- **RCL** — Receita Corrente Líquida. Base de vários limites da LRF.
- **LC 131/2009** — Lei da Transparência. Obriga divulgação em tempo real.
- **LAI** — Lei de Acesso à Informação (12.527/2011); o **e-SIC** é o canal de
  pedidos.

## Folha e previdência

- **RGPS** — Regime Geral de Previdência Social (INSS). O regime dos celetistas.
- **RPPS** — Regime Próprio de Previdência Social. O dos servidores efetivos;
  cada ente tem o seu, com alíquotas em lei municipal. Hoje **inexistente** no
  sistema (backlog O1-02).
- **INSS / IRRF** — contribuição previdenciária e imposto de renda retido, ambos
  por tabela progressiva de faixas.
- **eSocial** — sistema federal que recebe os eventos trabalhistas e de folha.
- **CNAB 240** — layout FEBRABAN de remessa bancária, registros de 240 posições.
  O que o sistema gera hoje **não** é CNAB 240 (backlog O1-07).
- **Rubrica** — cada linha do contracheque (provento ou desconto). Ver
  `payroll_rubrics`.

## Tributação municipal

- **IPTU / ISS / ITBI** — impostos municipais (predial, sobre serviços, sobre
  transmissão de imóveis).
- **Dívida ativa** — créditos não pagos, inscritos para cobrança.
- **CDA** — Certidão de Dívida Ativa; o título que embasa a execução fiscal.
- **NFS-e** — Nota Fiscal de Serviços eletrônica (padrão nacional).

## Modelo de identidade e vínculo

Três tabelas distintas, de propósito (ADR 0004) — não confundir:

- **`profiles`** — a **identidade de login**: quem autentica. 1:1 com a conta
  (`profiles.id = app_users.id`). Carrega dados de acesso, não o registro civil.
- **`persons`** — o **registro civil**: quem a pessoa é (CPF, nome, nascimento,
  dados sensíveis). Uma pessoa existe independentemente de ter login. Ligada ao
  login por `profiles.person_id → persons.id`.
- **`employment_links`** — o **vínculo** (o contrato/lotação numa entidade):
  `person_id → persons.id` (a pessoa) e `tenant_id` (o ente). A folha, o ponto e
  as movimentações penduram no vínculo, não no login.

Topologia: `app_users.id = profiles.id`; `profiles.person_id → persons.id`;
`employment_links.person_id → persons.id` e `employment_links.source_profile_id
→ profiles.id` (elo legado). O caminho novo (pessoas, folha por ciclo) lê o
civil de `persons` e o emprego de `employment_links`, nunca de `profiles`.

## Folha — geração válida

- **`payroll_cycles`** (+ `payroll_cycle_results`) — a **folha válida**: grão
  competência por ente, com resultado por vínculo, ciclo auditável
  (prévia → conferência → aprovação → fechamento → reabertura), versão e trilha.
  Tela: `/rh/ciclos`.
- **`payroll_periods`** — a folha **legada**, congelada no O0-13 (grão
  usuário/mês com horas). Preservada só como leitura; sem tela e fora do shim.
  Ver ADR 0005 e 0017.
- **`payroll_config`** — o singleton fiscal **legado** (faixas INSS/IRRF de 2025
  sem vigência nem ente), congelado no O1-01b. A fonte fiscal viva é
  `fiscal_tables` / `fiscal_table_versions` (versionadas, com checksum). Fora do
  shim, só leitura no banco. Ver ADR 0003 e 0017.
