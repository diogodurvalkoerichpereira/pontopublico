-- O2-35 — Catalogo de classificacao orcamentaria (referencia).
--
-- Funcao, subfuncao, natureza da despesa e fonte de recurso eram campo LIVRE:
-- o usuario digitava o codigo de cabeca em toda dotacao. Duas consequencias:
-- erro de digitacao vira classificacao inexistente (e o relatorio agrupa errado),
-- e o mesmo codigo entra com grafias diferentes ("3.1.90.11" e "319011"), que o
-- agrupamento trata como coisas distintas.
--
-- Uma tabela so, com `tipo` discriminando o nivel. E catalogo de REFERENCIA, nao
-- declaracao de conformidade (ver src/lib/conformance.ts): as linhas com
-- tenant_id NULO sao o padrao nacional que acompanha o sistema; o ente pode
-- acrescentar as suas (tenant_id preenchido) e desativar as que nao usa.
--
-- Fontes das listas, para quem for conferir:
--   funcao/subfuncao ....... Portaria MOG no 42/1999
--   natureza da despesa .... Portaria Interministerial STN/SOF no 163/2001
--   fonte de recurso ....... Portaria Conjunta STN/SOF no 20/2021 (padronizacao
--                            das fontes/destinacoes para todos os entes)
--
-- ATENCAO: o Tribunal de Contas do ente pode exigir detalhamento proprio, em
-- especial na fonte de recurso. Por isso o campo na tela e um seletor que TAMBEM
-- aceita digitacao livre: o catalogo ajuda, nao aprisiona.

begin;

create table if not exists public.budget_reference_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  tipo text not null,
  codigo text not null,
  nome text not null,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint budget_ref_tipo_check check (tipo in (
    'funcao',
    'subfuncao',
    'natureza_categoria',
    'natureza_grupo',
    'natureza_modalidade',
    'natureza_elemento',
    'fonte_recurso'
  )),
  constraint budget_ref_codigo_not_blank check (btrim(codigo) <> ''),
  constraint budget_ref_nome_not_blank check (btrim(nome) <> '')
);

-- Um codigo por tipo, por ente. O indice parcial cobre o catalogo padrao
-- (tenant_id nulo), onde `unique` sozinho nao impediria a duplicata.
create unique index if not exists budget_ref_tenant_unique
  on public.budget_reference_codes (tenant_id, tipo, codigo)
  where tenant_id is not null;

create unique index if not exists budget_ref_padrao_unique
  on public.budget_reference_codes (tipo, codigo)
  where tenant_id is null;

create index if not exists budget_ref_tipo_idx
  on public.budget_reference_codes (tipo, ativo);

alter table public.budget_reference_codes enable row level security;

do $$
begin
  if to_regnamespace('auth') is not null then
    create policy budget_ref_read on public.budget_reference_codes
      for select to authenticated
      using (tenant_id is null or private.has_tenant_permission(tenant_id, 'budget.read'));
    create policy budget_ref_write on public.budget_reference_codes
      for all to authenticated
      using (tenant_id is not null and private.has_tenant_permission(tenant_id, 'budget.manage'))
      with check (tenant_id is not null and private.has_tenant_permission(tenant_id, 'budget.manage'));
  end if;
end$$;

revoke all on public.budget_reference_codes from anon;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.budget_reference_codes to authenticated;
  end if;
end$$;

-- --- Funcoes de governo (Portaria MOG 42/1999) -----------------------------
insert into public.budget_reference_codes (tenant_id, tipo, codigo, nome) values
  (null, 'funcao', '01', 'Legislativa'),
  (null, 'funcao', '02', 'Judiciaria'),
  (null, 'funcao', '03', 'Essencial a Justica'),
  (null, 'funcao', '04', 'Administracao'),
  (null, 'funcao', '05', 'Defesa Nacional'),
  (null, 'funcao', '06', 'Seguranca Publica'),
  (null, 'funcao', '07', 'Relacoes Exteriores'),
  (null, 'funcao', '08', 'Assistencia Social'),
  (null, 'funcao', '09', 'Previdencia Social'),
  (null, 'funcao', '10', 'Saude'),
  (null, 'funcao', '11', 'Trabalho'),
  (null, 'funcao', '12', 'Educacao'),
  (null, 'funcao', '13', 'Cultura'),
  (null, 'funcao', '14', 'Direitos da Cidadania'),
  (null, 'funcao', '15', 'Urbanismo'),
  (null, 'funcao', '16', 'Habitacao'),
  (null, 'funcao', '17', 'Saneamento'),
  (null, 'funcao', '18', 'Gestao Ambiental'),
  (null, 'funcao', '19', 'Ciencia e Tecnologia'),
  (null, 'funcao', '20', 'Agricultura'),
  (null, 'funcao', '21', 'Organizacao Agraria'),
  (null, 'funcao', '22', 'Industria'),
  (null, 'funcao', '23', 'Comercio e Servicos'),
  (null, 'funcao', '24', 'Comunicacoes'),
  (null, 'funcao', '25', 'Energia'),
  (null, 'funcao', '26', 'Transporte'),
  (null, 'funcao', '27', 'Desporto e Lazer'),
  (null, 'funcao', '28', 'Encargos Especiais'),
  (null, 'funcao', '99', 'Reserva de Contingencia')
on conflict do nothing;

-- --- Subfuncoes (Portaria MOG 42/1999; combinacao matricial com a funcao) ---
insert into public.budget_reference_codes (tenant_id, tipo, codigo, nome) values
  (null, 'subfuncao', '031', 'Acao Legislativa'),
  (null, 'subfuncao', '032', 'Controle Externo'),
  (null, 'subfuncao', '061', 'Acao Judiciaria'),
  (null, 'subfuncao', '062', 'Defesa do Interesse Publico no Processo Judiciario'),
  (null, 'subfuncao', '091', 'Defesa da Ordem Juridica'),
  (null, 'subfuncao', '092', 'Representacao Judicial e Extrajudicial'),
  (null, 'subfuncao', '121', 'Planejamento e Orcamento'),
  (null, 'subfuncao', '122', 'Administracao Geral'),
  (null, 'subfuncao', '123', 'Administracao Financeira'),
  (null, 'subfuncao', '124', 'Controle Interno'),
  (null, 'subfuncao', '125', 'Normatizacao e Fiscalizacao'),
  (null, 'subfuncao', '126', 'Tecnologia da Informacao'),
  (null, 'subfuncao', '127', 'Ordenamento Territorial'),
  (null, 'subfuncao', '128', 'Formacao de Recursos Humanos'),
  (null, 'subfuncao', '129', 'Administracao de Receitas'),
  (null, 'subfuncao', '130', 'Administracao de Concessoes'),
  (null, 'subfuncao', '131', 'Comunicacao Social'),
  (null, 'subfuncao', '151', 'Defesa Aerea'),
  (null, 'subfuncao', '152', 'Defesa Naval'),
  (null, 'subfuncao', '153', 'Defesa Terrestre'),
  (null, 'subfuncao', '181', 'Policiamento'),
  (null, 'subfuncao', '182', 'Defesa Civil'),
  (null, 'subfuncao', '183', 'Informacao e Inteligencia'),
  (null, 'subfuncao', '211', 'Relacoes Diplomaticas'),
  (null, 'subfuncao', '212', 'Cooperacao Internacional'),
  (null, 'subfuncao', '241', 'Assistencia ao Idoso'),
  (null, 'subfuncao', '242', 'Assistencia ao Portador de Deficiencia'),
  (null, 'subfuncao', '243', 'Assistencia a Crianca e ao Adolescente'),
  (null, 'subfuncao', '244', 'Assistencia Comunitaria'),
  (null, 'subfuncao', '271', 'Previdencia Basica'),
  (null, 'subfuncao', '272', 'Previdencia do Regime Estatutario'),
  (null, 'subfuncao', '273', 'Previdencia Complementar'),
  (null, 'subfuncao', '274', 'Previdencia Especial'),
  (null, 'subfuncao', '301', 'Atencao Basica'),
  (null, 'subfuncao', '302', 'Assistencia Hospitalar e Ambulatorial'),
  (null, 'subfuncao', '303', 'Suporte Profilatico e Terapeutico'),
  (null, 'subfuncao', '304', 'Vigilancia Sanitaria'),
  (null, 'subfuncao', '305', 'Vigilancia Epidemiologica'),
  (null, 'subfuncao', '306', 'Alimentacao e Nutricao'),
  (null, 'subfuncao', '331', 'Protecao e Beneficios ao Trabalhador'),
  (null, 'subfuncao', '332', 'Relacoes de Trabalho'),
  (null, 'subfuncao', '333', 'Empregabilidade'),
  (null, 'subfuncao', '334', 'Fomento ao Trabalho'),
  (null, 'subfuncao', '361', 'Ensino Fundamental'),
  (null, 'subfuncao', '362', 'Ensino Medio'),
  (null, 'subfuncao', '363', 'Ensino Profissional'),
  (null, 'subfuncao', '364', 'Ensino Superior'),
  (null, 'subfuncao', '365', 'Educacao Infantil'),
  (null, 'subfuncao', '366', 'Educacao de Jovens e Adultos'),
  (null, 'subfuncao', '367', 'Educacao Especial'),
  (null, 'subfuncao', '368', 'Educacao Basica'),
  (null, 'subfuncao', '391', 'Patrimonio Historico, Artistico e Arqueologico'),
  (null, 'subfuncao', '392', 'Difusao Cultural'),
  (null, 'subfuncao', '421', 'Custodia e Reintegracao Social'),
  (null, 'subfuncao', '422', 'Direitos Individuais, Coletivos e Difusos'),
  (null, 'subfuncao', '423', 'Assistencia aos Povos Indigenas'),
  (null, 'subfuncao', '451', 'Infraestrutura Urbana'),
  (null, 'subfuncao', '452', 'Servicos Urbanos'),
  (null, 'subfuncao', '453', 'Transportes Coletivos Urbanos'),
  (null, 'subfuncao', '481', 'Habitacao Rural'),
  (null, 'subfuncao', '482', 'Habitacao Urbana'),
  (null, 'subfuncao', '511', 'Saneamento Basico Rural'),
  (null, 'subfuncao', '512', 'Saneamento Basico Urbano'),
  (null, 'subfuncao', '541', 'Preservacao e Conservacao Ambiental'),
  (null, 'subfuncao', '542', 'Controle Ambiental'),
  (null, 'subfuncao', '543', 'Recuperacao de Areas Degradadas'),
  (null, 'subfuncao', '544', 'Recursos Hidricos'),
  (null, 'subfuncao', '545', 'Meteorologia'),
  (null, 'subfuncao', '571', 'Desenvolvimento Cientifico'),
  (null, 'subfuncao', '572', 'Desenvolvimento Tecnologico e Engenharia'),
  (null, 'subfuncao', '573', 'Difusao do Conhecimento Cientifico e Tecnologico'),
  (null, 'subfuncao', '601', 'Promocao da Producao Vegetal'),
  (null, 'subfuncao', '602', 'Promocao da Producao Animal'),
  (null, 'subfuncao', '603', 'Defesa Sanitaria Vegetal'),
  (null, 'subfuncao', '604', 'Defesa Sanitaria Animal'),
  (null, 'subfuncao', '605', 'Abastecimento'),
  (null, 'subfuncao', '606', 'Extensao Rural'),
  (null, 'subfuncao', '607', 'Irrigacao'),
  (null, 'subfuncao', '631', 'Reforma Agraria'),
  (null, 'subfuncao', '632', 'Colonizacao'),
  (null, 'subfuncao', '661', 'Promocao Industrial'),
  (null, 'subfuncao', '662', 'Producao Industrial'),
  (null, 'subfuncao', '663', 'Mineracao'),
  (null, 'subfuncao', '664', 'Propriedade Industrial'),
  (null, 'subfuncao', '665', 'Normalizacao e Qualidade'),
  (null, 'subfuncao', '691', 'Promocao Comercial'),
  (null, 'subfuncao', '692', 'Comercializacao'),
  (null, 'subfuncao', '693', 'Comercio Exterior'),
  (null, 'subfuncao', '694', 'Servicos Financeiros'),
  (null, 'subfuncao', '695', 'Turismo'),
  (null, 'subfuncao', '721', 'Comunicacoes Postais'),
  (null, 'subfuncao', '722', 'Telecomunicacoes'),
  (null, 'subfuncao', '751', 'Conservacao de Energia'),
  (null, 'subfuncao', '752', 'Energia Eletrica'),
  (null, 'subfuncao', '753', 'Combustiveis Minerais'),
  (null, 'subfuncao', '754', 'Biocombustiveis'),
  (null, 'subfuncao', '781', 'Transporte Aereo'),
  (null, 'subfuncao', '782', 'Transporte Rodoviario'),
  (null, 'subfuncao', '783', 'Transporte Ferroviario'),
  (null, 'subfuncao', '784', 'Transporte Hidroviario'),
  (null, 'subfuncao', '785', 'Transportes Especiais'),
  (null, 'subfuncao', '811', 'Desporto de Rendimento'),
  (null, 'subfuncao', '812', 'Desporto Comunitario'),
  (null, 'subfuncao', '813', 'Lazer'),
  (null, 'subfuncao', '841', 'Refinanciamento da Divida Interna'),
  (null, 'subfuncao', '842', 'Refinanciamento da Divida Externa'),
  (null, 'subfuncao', '843', 'Servico da Divida Interna'),
  (null, 'subfuncao', '844', 'Servico da Divida Externa'),
  (null, 'subfuncao', '845', 'Outras Transferencias'),
  (null, 'subfuncao', '846', 'Outros Encargos Especiais'),
  (null, 'subfuncao', '847', 'Transferencias para a Educacao Basica'),
  (null, 'subfuncao', '999', 'Reserva de Contingencia')
on conflict do nothing;

-- --- Natureza da despesa: categoria economica (Portaria 163/2001) ----------
insert into public.budget_reference_codes (tenant_id, tipo, codigo, nome) values
  (null, 'natureza_categoria', '3', 'Despesas Correntes'),
  (null, 'natureza_categoria', '4', 'Despesas de Capital')
on conflict do nothing;

-- --- Natureza da despesa: grupo ---------------------------------------------
insert into public.budget_reference_codes (tenant_id, tipo, codigo, nome) values
  (null, 'natureza_grupo', '1', 'Pessoal e Encargos Sociais'),
  (null, 'natureza_grupo', '2', 'Juros e Encargos da Divida'),
  (null, 'natureza_grupo', '3', 'Outras Despesas Correntes'),
  (null, 'natureza_grupo', '4', 'Investimentos'),
  (null, 'natureza_grupo', '5', 'Inversoes Financeiras'),
  (null, 'natureza_grupo', '6', 'Amortizacao da Divida'),
  (null, 'natureza_grupo', '9', 'Reserva de Contingencia')
on conflict do nothing;

-- --- Natureza da despesa: modalidade de aplicacao --------------------------
insert into public.budget_reference_codes (tenant_id, tipo, codigo, nome) values
  (null, 'natureza_modalidade', '20', 'Transferencias a Uniao'),
  (null, 'natureza_modalidade', '30', 'Transferencias a Estados e ao Distrito Federal'),
  (null, 'natureza_modalidade', '31', 'Transferencias a Estados e ao DF - Fundo a Fundo'),
  (null, 'natureza_modalidade', '40', 'Transferencias a Municipios'),
  (null, 'natureza_modalidade', '41', 'Transferencias a Municipios - Fundo a Fundo'),
  (null, 'natureza_modalidade', '50', 'Transferencias a Instituicoes Privadas sem Fins Lucrativos'),
  (null, 'natureza_modalidade', '60', 'Transferencias a Instituicoes Privadas com Fins Lucrativos'),
  (null, 'natureza_modalidade', '67', 'Execucao de Contrato de Parceria Publico-Privada (PPP)'),
  (null, 'natureza_modalidade', '70', 'Transferencias a Instituicoes Multigovernamentais'),
  (null, 'natureza_modalidade', '71', 'Transferencias a Consorcios Publicos (contrato de rateio)'),
  (null, 'natureza_modalidade', '72', 'Execucao Orcamentaria Delegada a Consorcios Publicos'),
  (null, 'natureza_modalidade', '80', 'Transferencias ao Exterior'),
  (null, 'natureza_modalidade', '90', 'Aplicacoes Diretas'),
  (null, 'natureza_modalidade', '91', 'Aplicacao Direta - Operacao entre Orgaos do mesmo Orcamento'),
  (null, 'natureza_modalidade', '99', 'A Definir')
on conflict do nothing;

-- --- Natureza da despesa: elemento ------------------------------------------
insert into public.budget_reference_codes (tenant_id, tipo, codigo, nome) values
  (null, 'natureza_elemento', '01', 'Aposentadorias do RPPS, Reserva Remunerada e Reformas dos Militares'),
  (null, 'natureza_elemento', '03', 'Pensoes do RPPS e do Militar'),
  (null, 'natureza_elemento', '04', 'Contratacao por Tempo Determinado'),
  (null, 'natureza_elemento', '05', 'Outros Beneficios Previdenciarios do Servidor ou do Militar'),
  (null, 'natureza_elemento', '06', 'Beneficio Mensal ao Deficiente e ao Idoso'),
  (null, 'natureza_elemento', '07', 'Contribuicao a Entidades Fechadas de Previdencia'),
  (null, 'natureza_elemento', '08', 'Outros Beneficios Assistenciais do Servidor e do Militar'),
  (null, 'natureza_elemento', '09', 'Salario-Familia'),
  (null, 'natureza_elemento', '10', 'Seguro Desemprego e Abono Salarial'),
  (null, 'natureza_elemento', '11', 'Vencimentos e Vantagens Fixas - Pessoal Civil'),
  (null, 'natureza_elemento', '12', 'Vencimentos e Vantagens Fixas - Pessoal Militar'),
  (null, 'natureza_elemento', '13', 'Obrigacoes Patronais'),
  (null, 'natureza_elemento', '14', 'Diarias - Civil'),
  (null, 'natureza_elemento', '15', 'Diarias - Militar'),
  (null, 'natureza_elemento', '16', 'Outras Despesas Variaveis - Pessoal Civil'),
  (null, 'natureza_elemento', '17', 'Outras Despesas Variaveis - Pessoal Militar'),
  (null, 'natureza_elemento', '18', 'Auxilio Financeiro a Estudantes'),
  (null, 'natureza_elemento', '19', 'Auxilio-Fardamento'),
  (null, 'natureza_elemento', '20', 'Auxilio Financeiro a Pesquisadores'),
  (null, 'natureza_elemento', '21', 'Juros sobre a Divida por Contrato'),
  (null, 'natureza_elemento', '22', 'Outros Encargos sobre a Divida por Contrato'),
  (null, 'natureza_elemento', '23', 'Juros, Desagios e Descontos da Divida Mobiliaria'),
  (null, 'natureza_elemento', '24', 'Outros Encargos sobre a Divida Mobiliaria'),
  (null, 'natureza_elemento', '25', 'Encargos sobre Operacoes de Credito por Antecipacao da Receita'),
  (null, 'natureza_elemento', '30', 'Material de Consumo'),
  (null, 'natureza_elemento', '31', 'Premiacoes Culturais, Artisticas, Cientificas, Desportivas e Outras'),
  (null, 'natureza_elemento', '32', 'Material, Bem ou Servico para Distribuicao Gratuita'),
  (null, 'natureza_elemento', '33', 'Passagens e Despesas com Locomocao'),
  (null, 'natureza_elemento', '34', 'Outras Despesas de Pessoal decorrentes de Contratos de Terceirizacao'),
  (null, 'natureza_elemento', '35', 'Servicos de Consultoria'),
  (null, 'natureza_elemento', '36', 'Outros Servicos de Terceiros - Pessoa Fisica'),
  (null, 'natureza_elemento', '37', 'Locacao de Mao de Obra'),
  (null, 'natureza_elemento', '38', 'Arrendamento Mercantil'),
  (null, 'natureza_elemento', '39', 'Outros Servicos de Terceiros - Pessoa Juridica'),
  (null, 'natureza_elemento', '41', 'Contribuicoes'),
  (null, 'natureza_elemento', '42', 'Auxilios'),
  (null, 'natureza_elemento', '43', 'Subvencoes Sociais'),
  (null, 'natureza_elemento', '45', 'Subvencoes Economicas'),
  (null, 'natureza_elemento', '46', 'Auxilio-Alimentacao'),
  (null, 'natureza_elemento', '47', 'Obrigacoes Tributarias e Contributivas'),
  (null, 'natureza_elemento', '48', 'Outros Auxilios Financeiros a Pessoas Fisicas'),
  (null, 'natureza_elemento', '49', 'Auxilio-Transporte'),
  (null, 'natureza_elemento', '51', 'Obras e Instalacoes'),
  (null, 'natureza_elemento', '52', 'Equipamentos e Material Permanente'),
  (null, 'natureza_elemento', '53', 'Aposentadorias do RGPS'),
  (null, 'natureza_elemento', '54', 'Pensoes do RGPS'),
  (null, 'natureza_elemento', '55', 'Outros Beneficios do RGPS'),
  (null, 'natureza_elemento', '59', 'Pensoes Especiais'),
  (null, 'natureza_elemento', '61', 'Aquisicao de Imoveis'),
  (null, 'natureza_elemento', '62', 'Aquisicao de Produtos para Revenda'),
  (null, 'natureza_elemento', '63', 'Aquisicao de Titulos de Credito'),
  (null, 'natureza_elemento', '64', 'Aquisicao de Titulos Representativos de Capital ja Integralizado'),
  (null, 'natureza_elemento', '65', 'Constituicao ou Aumento de Capital de Empresas'),
  (null, 'natureza_elemento', '66', 'Concessao de Emprestimos e Financiamentos'),
  (null, 'natureza_elemento', '67', 'Depositos Compulsorios'),
  (null, 'natureza_elemento', '70', 'Rateio pela Participacao em Consorcio Publico'),
  (null, 'natureza_elemento', '71', 'Principal da Divida Contratual Resgatado'),
  (null, 'natureza_elemento', '72', 'Principal da Divida Mobiliaria Resgatado'),
  (null, 'natureza_elemento', '73', 'Correcao Monetaria ou Cambial da Divida Contratual Resgatada'),
  (null, 'natureza_elemento', '74', 'Correcao Monetaria ou Cambial da Divida Mobiliaria Resgatada'),
  (null, 'natureza_elemento', '75', 'Correcao Monetaria da Divida de Operacoes de Credito por Antecipacao da Receita'),
  (null, 'natureza_elemento', '76', 'Principal Corrigido da Divida Mobiliaria Refinanciado'),
  (null, 'natureza_elemento', '77', 'Principal Corrigido da Divida Contratual Refinanciado'),
  (null, 'natureza_elemento', '81', 'Distribuicao de Resultado de Empresas Estatais Dependentes'),
  (null, 'natureza_elemento', '91', 'Sentencas Judiciais'),
  (null, 'natureza_elemento', '92', 'Despesas de Exercicios Anteriores'),
  (null, 'natureza_elemento', '93', 'Indenizacoes e Restituicoes'),
  (null, 'natureza_elemento', '94', 'Indenizacoes e Restituicoes Trabalhistas'),
  (null, 'natureza_elemento', '95', 'Indenizacoes pela Execucao de Trabalhos de Campo'),
  (null, 'natureza_elemento', '96', 'Ressarcimento de Despesas de Pessoal Requisitado'),
  (null, 'natureza_elemento', '97', 'Aporte para Cobertura do Deficit Atuarial do RPPS'),
  (null, 'natureza_elemento', '98', 'Compensacoes ao RGPS'),
  (null, 'natureza_elemento', '99', 'A Classificar')
on conflict do nothing;

-- --- Fonte/destinacao de recursos (Portaria Conjunta STN/SOF 20/2021) -------
-- O codigo de 3 digitos abaixo e a fonte. Na escrituracao ele costuma vir
-- prefixado pelo identificador de exercicio: 1 = recursos do exercicio corrente,
-- 2 = recursos de exercicios anteriores (superavit), 9 = recursos condicionados.
-- Ex.: "1500" = exercicio corrente / Recursos nao Vinculados de Impostos.
insert into public.budget_reference_codes (tenant_id, tipo, codigo, nome) values
  (null, 'fonte_recurso', '500', 'Recursos nao Vinculados de Impostos'),
  (null, 'fonte_recurso', '501', 'Outros Recursos nao Vinculados'),
  (null, 'fonte_recurso', '540', 'Transferencias do FUNDEB - Impostos e Transferencias de Impostos'),
  (null, 'fonte_recurso', '541', 'Transferencias do FUNDEB - Complementacao da Uniao (VAAF)'),
  (null, 'fonte_recurso', '542', 'Transferencias do FUNDEB - Complementacao da Uniao (VAAT)'),
  (null, 'fonte_recurso', '550', 'Transferencia do Salario-Educacao'),
  (null, 'fonte_recurso', '551', 'Transferencias do FNDE relativas ao PNAE'),
  (null, 'fonte_recurso', '552', 'Transferencias do FNDE relativas ao PNATE'),
  (null, 'fonte_recurso', '553', 'Outras Transferencias de Recursos do FNDE'),
  (null, 'fonte_recurso', '554', 'Convenios e Congeneres do Governo Federal vinculados a Educacao'),
  (null, 'fonte_recurso', '555', 'Convenios e Congeneres do Estado vinculados a Educacao'),
  (null, 'fonte_recurso', '569', 'Outros Recursos Destinados a Educacao'),
  (null, 'fonte_recurso', '600', 'Transferencias Fundo a Fundo do SUS - Governo Federal'),
  (null, 'fonte_recurso', '601', 'Transferencias Fundo a Fundo do SUS - Governo Estadual'),
  (null, 'fonte_recurso', '602', 'Convenios e Congeneres destinados a Saude'),
  (null, 'fonte_recurso', '621', 'Outros Recursos Destinados a Saude'),
  (null, 'fonte_recurso', '660', 'Transferencias Fundo a Fundo de Recursos do SUAS'),
  (null, 'fonte_recurso', '661', 'Convenios e Congeneres destinados a Assistencia Social'),
  (null, 'fonte_recurso', '669', 'Outros Recursos Destinados a Assistencia Social'),
  (null, 'fonte_recurso', '700', 'Outras Transferencias de Convenios ou Congeneres da Uniao'),
  (null, 'fonte_recurso', '701', 'Outras Transferencias de Convenios ou Congeneres dos Estados'),
  (null, 'fonte_recurso', '702', 'Outras Transferencias de Convenios ou Congeneres dos Municipios'),
  (null, 'fonte_recurso', '703', 'Outras Transferencias de Convenios - Multigovernamentais'),
  (null, 'fonte_recurso', '704', 'Outras Transferencias de Convenios - Entidades Privadas'),
  (null, 'fonte_recurso', '750', 'Recursos de Operacoes de Credito'),
  (null, 'fonte_recurso', '759', 'Outros Recursos Vinculados a Operacoes de Credito'),
  (null, 'fonte_recurso', '760', 'Recursos de Alienacao de Bens e Direitos'),
  (null, 'fonte_recurso', '770', 'Transferencias do Governo Federal - Emendas Parlamentares Individuais'),
  (null, 'fonte_recurso', '771', 'Transferencias do Governo Federal - Emendas de Bancada'),
  (null, 'fonte_recurso', '772', 'Transferencias Especiais da Uniao'),
  (null, 'fonte_recurso', '780', 'Recursos Vinculados ao RPPS - Plano Previdenciario'),
  (null, 'fonte_recurso', '781', 'Recursos Vinculados ao RPPS - Plano Financeiro'),
  (null, 'fonte_recurso', '782', 'Recursos Vinculados ao RPPS - Taxa de Administracao'),
  (null, 'fonte_recurso', '790', 'Recursos Vinculados ao Regime Proprio de Saude do Servidor'),
  (null, 'fonte_recurso', '799', 'Outros Recursos Vinculados')
on conflict do nothing;

commit;
