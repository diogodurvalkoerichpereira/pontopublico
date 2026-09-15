/**
 * "Como fazer" de cada tela — o roteiro das operações que ela permite.
 *
 * Módulo **puro** (sem imports de servidor): o `AppShell` o lê pelo caminho da
 * rota e mostra o painel em qualquer tela, sem que cada rota precise saber disso.
 *
 * O que entra aqui é o que o usuário precisa saber ANTES de clicar: a ordem dos
 * passos, o pré-requisito que costuma faltar, e a consequência do que não tem
 * volta. O que a tela já diz sozinha (o rótulo do campo, o formato da data) não
 * entra — repetir o óbvio faz o painel deixar de ser lido.
 */

export type PassoDeAjuda = {
  /** O verbo: "Cadastrar", "Inscrever", "Alterar", "Cancelar"… */
  acao: string;
  /** O caminho, em uma ou duas frases. */
  como: string;
  /** Pré-requisito, pegadinha ou o que não tem volta. Opcional. */
  atencao?: string;
};

export type AjudaDeTela = {
  titulo: string;
  /** Para que serve a tela, em uma frase. */
  resumo: string;
  passos: PassoDeAjuda[];
};

const AJUDA: Record<string, AjudaDeTela> = {
  // --- Administração e governança ------------------------------------------
  "/admin/estrutura": {
    titulo: "Estrutura organizacional",
    resumo:
      "A entidade (o ente público) e suas unidades — secretarias, departamentos, setores.",
    passos: [
      {
        acao: "Cadastrar a entidade",
        como: 'Botão "Nova entidade". Informe nome, CNPJ e o fuso horário.',
        atencao:
          "É o primeiro cadastro do sistema. Sem uma entidade ativa selecionada, nenhum módulo abre.",
      },
      {
        acao: "Cadastrar uma unidade",
        como: 'Botão "Nova unidade". Código, nome e tipo; deixe a unidade-pai em branco para uma unidade de primeiro nível.',
        atencao:
          "A unidade é o que permite lotar pessoas e restringir o acesso por setor.",
      },
      {
        acao: "Alterar",
        como: "Clique na unidade e edite. O mesmo formulário serve para criar e para alterar.",
      },
    ],
  },
  "/admin/seguranca": {
    titulo: "Papéis e acessos",
    resumo: "Quem pode fazer o quê, por entidade.",
    passos: [
      {
        acao: "Criar um papel",
        como: 'Botão "Novo papel". Dê um código e um nome, e marque as permissões que ele concede.',
        atencao:
          "Comece pelo menor conjunto de permissões. Ampliar depois é fácil; descobrir que alguém via demais, não.",
      },
      {
        acao: "Atribuir a um usuário",
        como: "Na aba de atribuições, escolha o usuário, o papel e a vigência.",
        atencao:
          "Usuário sem papel não enxerga módulo nenhum — é assim por desenho.",
      },
      {
        acao: "Revogar",
        como: "Marque a atribuição como revogada, ou informe a data final de vigência.",
      },
    ],
  },
  "/admin/usuarios": {
    titulo: "Usuários",
    resumo: "Contas de acesso ao sistema.",
    passos: [
      {
        acao: "Criar usuário",
        como: 'Botão "Novo usuário": e-mail, senha inicial, nome e papel.',
        atencao:
          "Criar a conta não dá acesso a nada. O acesso vem do papel, em Papéis e acessos.",
      },
      {
        acao: "Redefinir senha",
        como: "Botão de redefinir na linha do usuário. A senha nova exige 12 caracteres, com maiúscula, minúscula, número e símbolo.",
      },
    ],
  },
  "/admin/configuracoes": {
    titulo: "Configurações",
    resumo: "Envio de e-mail (SMTP) do sistema.",
    passos: [
      {
        acao: "Configurar o e-mail",
        como: "Preencha servidor, porta, usuário e senha, e grave.",
        atencao:
          "As credenciais ficam no banco, não em variável de ambiente. Enquanto não houver um registro aqui, todo envio falha.",
      },
      {
        acao: "Testar",
        como: "Use o botão de envio de teste antes de depender do e-mail de verdade.",
      },
    ],
  },
  "/admin/auditoria": {
    titulo: "Auditoria",
    resumo: "Quem fez o quê, quando, em cada registro.",
    passos: [
      {
        acao: "Consultar",
        como: "Filtre por recurso, ação ou período. Cada linha traz o autor e o estado do registro depois do ato.",
        atencao:
          "A trilha é só de leitura — não há como editar nem apagar um evento. É isso que lhe dá valor.",
      },
    ],
  },

  // --- Recursos humanos ------------------------------------------------------
  "/rh/pessoas": {
    titulo: "Pessoas e vínculos",
    resumo: "O cadastro do servidor e o vínculo dele com o ente.",
    passos: [
      {
        acao: "Cadastrar",
        como: 'Botão "Nova pessoa". Dados pessoais e, na sequência, o vínculo: matrícula, lotação, cargo, regime, jornada e data de admissão.',
        atencao:
          "O vínculo só fica ativo com lotação, tipo, regime, cargo, jornada e admissão preenchidos. Antes disso ele nasce como rascunho.",
      },
      {
        acao: "Alterar",
        como: "Abra a pessoa e edite. Mudança de cargo, lotação ou salário vai em Movimentações, não aqui.",
        atencao:
          "Editar o cadastro não deixa histórico do que mudou no vínculo; a movimentação deixa.",
      },
    ],
  },
  "/rh/movimentacoes": {
    titulo: "Movimentações funcionais",
    resumo:
      "Os atos que mudam a vida funcional: promoção, remoção, cessão, licença.",
    passos: [
      {
        acao: "Registrar",
        como: "Escolha o vínculo, o tipo de movimentação, a data de efeito e a fundamentação legal.",
        atencao:
          "A data de efeito é o que a folha enxerga. Registrar com a data errada muda a competência do pagamento.",
      },
    ],
  },
  "/rh/rubricas": {
    titulo: "Rubricas da folha",
    resumo: "As verbas: proventos, descontos e informativas.",
    passos: [
      {
        acao: "Cadastrar",
        como: 'Botão "Nova rubrica": código, nome, natureza (provento/desconto/informativa) e ordem de cálculo.',
        atencao:
          "Sem rubricas a folha não tem o que somar. É o primeiro cadastro do módulo.",
      },
      {
        acao: "Versionar a fórmula",
        como: "Abra a rubrica e crie uma nova versão com a vigência. A versão anterior fica no histórico.",
        atencao:
          "Fórmula de rubrica não se edita no lugar: cria-se versão nova. É o que permite recalcular uma folha antiga com a regra da época.",
      },
    ],
  },
  "/rh/tabelas-fiscais": {
    titulo: "Tabelas fiscais",
    resumo: "Faixas de INSS, IRRF e afins, por vigência.",
    passos: [
      {
        acao: "Cadastrar a versão do exercício",
        como: "Escolha a tabela, crie a versão com a data de início e lance as faixas.",
        atencao:
          "Sem a tabela do exercício vigente a folha não calcula os descontos legais.",
      },
    ],
  },
  "/rh/ciclos": {
    titulo: "Folha de pagamento",
    resumo:
      "O ciclo da competência: prévia, conferência, aprovação e fechamento.",
    passos: [
      {
        acao: "Gerar a prévia",
        como: 'Botão "Gerar prévia" e escolha o cálculo de origem.',
      },
      {
        acao: "Conferir e aprovar",
        como: "Prévia → em conferência → aprovada → fechada. Cada passo é um botão, na ordem.",
        atencao:
          "Fechar a folha exige segundo fator (MFA). Configure o seu em Conta › Segurança antes.",
      },
      {
        acao: "Reabrir",
        como: "Só com justificativa de pelo menos 10 caracteres, e com permissão específica.",
        atencao: "A reabertura fica registrada na trilha, com o motivo.",
      },
      {
        acao: "Gerar a remessa bancária",
        como: "Na folha fechada, botão de remessa.",
        atencao:
          "O arquivo NÃO é CNAB 240 e nenhum banco o aceita — serve para conferência interna. A tela repete esse aviso.",
      },
    ],
  },
  "/rh/ponto": {
    titulo: "Ponto — registro probatório",
    resumo:
      "Marcações imutáveis, numeradas (NSR) e encadeadas por hash: alterar uma quebra a cadeia.",
    passos: [
      {
        acao: "Registrar marcação",
        como: "Escolha a competência e o servidor, e use “Registrar marcação”.",
        atencao:
          "A marcação NÃO tem edição nem exclusão. Correção se faz por marcação nova — e as duas ficam na cadeia.",
      },
      {
        acao: "Verificar a cadeia",
        como: 'Botão "Verificar cadeia": diz se está íntegra ou em que NSR quebrou.',
      },
      {
        acao: "Emitir comprovante",
        como: "Botão na linha da marcação. Traz o código verificador derivado do hash.",
        atencao:
          "É comprovante interno. O comprovante oficial da Portaria 671 depende de homologação e ainda não existe aqui.",
      },
      {
        acao: "Cadastrar feriado",
        como: "Seção de feriados, ao fim da tela. Ano em branco = recorre todo ano.",
        atencao:
          "É o feriado que zera o previsto do dia no espelho e na apuração.",
      },
      {
        acao: "Depositar na folha",
        como: 'Botão "Depositar na folha": escolha as rubricas de extras e faltas, o adicional e o divisor.',
        atencao: "Nada é adivinhado — a política é escolha explícita do RH.",
      },
    ],
  },
  "/rh/apuracao": {
    titulo: "Apuração de ponto",
    resumo: "Previsto × trabalhado do mês, por servidor.",
    passos: [
      {
        acao: "Consultar",
        como: "Escolha a competência. A lista vem ordenada pelo menor saldo — quem tem mais falta aparece primeiro.",
        atencao:
          "Só os dias COM marcação entram. Servidor sem marcação aparece zerado, não faltoso.",
      },
      {
        acao: "Lançar no banco de horas",
        como: "Botão na linha do servidor.",
      },
    ],
  },
  "/rh/jornadas": {
    titulo: "Jornadas semanais",
    resumo: "Quantos minutos são previstos em cada dia da semana.",
    passos: [
      {
        acao: "Cadastrar",
        como: "Defina a jornada e vincule ao servidor.",
        atencao:
          "Sem jornada, a apuração não tem previsto para comparar com o trabalhado.",
      },
    ],
  },
  "/rh/ferias": {
    titulo: "Férias",
    resumo: "Período aquisitivo, programação e gozo.",
    passos: [
      {
        acao: "Programar",
        como: "Escolha o vínculo, o período aquisitivo e as datas de gozo.",
        atencao:
          "A remuneração das férias entra na folha pela via do ciclo, com a tributação do mês.",
      },
    ],
  },
  "/rh/familia": {
    titulo: "Dependentes e pensões",
    resumo:
      "Quem é dependente para IRRF/salário-família e quem recebe pensão alimentícia.",
    passos: [
      {
        acao: "Cadastrar dependente",
        como: "Abra o servidor e inclua o dependente com a data de nascimento e a finalidade.",
        atencao:
          "A finalidade define o efeito: dependente de IRRF abate a base; de salário-família, gera a cota.",
      },
    ],
  },
  "/consignacoes": {
    titulo: "Consignações",
    resumo: "Descontos em folha por convênio, dentro da margem.",
    passos: [
      {
        acao: "Registrar",
        como: "Escolha o servidor, o consignatário, o valor da parcela e o prazo.",
        atencao:
          "A margem consignável é conferida no momento do registro: acima dela, o sistema recusa.",
      },
    ],
  },

  // --- Orçamento e despesa ---------------------------------------------------
  "/orcamento": {
    titulo: "Orçamento",
    resumo: "Dotações do exercício, contingenciamento e créditos adicionais.",
    passos: [
      {
        acao: "Cadastrar dotação",
        como: 'Botão "Nova dotação": a classificação completa (unidade, função, subfunção, programa, ação, natureza, fonte) e o valor orçado.',
        atencao:
          "É o começo de toda a cadeia da despesa. Sem dotação não há onde empenhar.",
      },
      {
        acao: "Contingenciar / liberar",
        como: 'Botões "Contingenciar" e "Liberar" na linha da dotação.',
        atencao:
          "O bloqueio não invade o já empenhado. Para reduzir uma dotação contingenciada, libere o bloqueio antes.",
      },
      {
        acao: "Remanejar crédito",
        como: 'Botão "Remanejar": anula na origem e suplementa no destino, num ato só.',
        atencao: "A origem nunca fica abaixo do já empenhado.",
      },
      {
        acao: "Abrir crédito suplementar",
        como: "Pelo excesso de arrecadação da fonte. A tela mostra o excesso disponível antes de você abrir.",
      },
    ],
  },
  "/empenhos": {
    titulo: "Empenhos",
    resumo: "O primeiro estágio da despesa (Lei 4.320 art. 58).",
    passos: [
      {
        acao: "Empenhar",
        como: 'Botão "Novo empenho": dotação, credor, histórico e valor.',
        atencao:
          "Só aparecem dotações ativas com saldo. Se a lista vier vazia, falta dotação ou saldo.",
      },
      {
        acao: "Liquidar",
        como: "Botão na linha do empenho, depois de conferida a entrega.",
        atencao: "É a liquidação que atesta o direito do credor (art. 63).",
      },
      {
        acao: "Pagar",
        como: 'O pagamento NÃO acontece aqui: use "Pagar por OB", que leva a Ordens bancárias.',
        atencao:
          "É a ordem bancária que debita a conta de tesouraria e contabiliza. Pagar por fora deixaria o caixa descolado.",
      },
      {
        acao: "Anular",
        como: "Botão de anular, enquanto o empenho não estiver pago.",
      },
    ],
  },
  "/ordens-bancarias": {
    titulo: "Ordens bancárias",
    resumo: "A saída de dinheiro: paga o empenho liquidado e debita a conta.",
    passos: [
      {
        acao: "Emitir",
        como: "Escolha o empenho liquidado, a conta de tesouraria e a data.",
        atencao:
          "A conta precisa ter saldo. Se toda OB é recusada por saldo, confira se a arrecadação está entrando em conta (tela de Receitas/Tributos).",
      },
      {
        acao: "Estornar",
        como: "Botão de estorno: devolve o valor à conta e reabre o resto a pagar.",
      },
    ],
  },
  "/restos-a-pagar": {
    titulo: "Restos a pagar",
    resumo:
      "Empenhos do exercício anterior inscritos no encerramento (art. 36).",
    passos: [
      {
        acao: "Inscrever",
        como: "Ao encerrar o exercício, inscreva os empenhos não pagos.",
        atencao:
          "Processado = já liquidado; não processado = ainda não. A distinção muda o tratamento no balanço.",
      },
      {
        acao: "Pagar",
        como: "Pela ordem bancária, como qualquer despesa.",
        atencao: "Resto não processado não paga sem liquidação prévia.",
      },
    ],
  },

  // --- Receita e tributos ----------------------------------------------------
  "/receitas": {
    titulo: "Receitas",
    resumo: "Previsão (LOA) e arrecadação.",
    passos: [
      {
        acao: "Prever",
        como: 'Botão "Nova receita": classificação, fonte e valor previsto no exercício.',
      },
      {
        acao: "Arrecadar",
        como: "Botão na linha da receita. Informe a conta que recebeu, o valor e o histórico.",
        atencao:
          "A conta é obrigatória: é ela que credita a tesouraria. Sem conta de tesouraria cadastrada, não há como arrecadar.",
      },
      {
        acao: "Estornar",
        como: "Botão de estorno na arrecadação lançada por engano.",
      },
    ],
  },
  "/tributos": {
    titulo: "Tributos",
    resumo: "Lançamento, arrecadação e dívida ativa dos créditos tributários.",
    passos: [
      {
        acao: "Lançar",
        como: 'IPTU, ISS e ITBI têm botões próprios (nascem do imóvel ou do prestador). Para taxa, COSIP e acertos, use "Novo lançamento".',
        atencao:
          "Para lançar ISS é preciso ter o contribuinte cadastrado antes — botão “Novo contribuinte ISS”.",
      },
      {
        acao: "Arrecadar",
        como: "Botão na linha do crédito. Informe a conta que recebeu e o valor.",
        atencao: "O valor nunca passa do saldo devedor. Quita quando zera.",
      },
      {
        acao: "Inscrever em dívida ativa",
        como: "Botão de inscrever, no crédito vencido e com saldo.",
        atencao:
          "Só crédito vencido, não quitado e não cancelado. A inscrição muda o tratamento na certidão.",
      },
      {
        acao: "Consultar regularidade",
        como: 'Botão "Regularidade fiscal": informe o CPF/CNPJ, com ou sem máscara.',
        atencao:
          "É consulta interna, não a certidão. Débito a vencer aparece no extrato mas não impede.",
      },
      {
        acao: "Cancelar",
        como: "Botão de cancelar, com o motivo.",
      },
    ],
  },
  "/parcelamentos": {
    titulo: "Parcelamentos",
    resumo: "Acordo de parcelamento do crédito em dívida ativa.",
    passos: [
      {
        acao: "Criar o acordo",
        como: "Escolha o crédito, o número de parcelas e o primeiro vencimento.",
        atencao:
          "Só crédito em dívida ativa é parcelável. O parcelamento ativo suspende a exigibilidade na certidão.",
      },
      {
        acao: "Pagar parcela",
        como: 'Botão "Pagar" na parcela. Informe a conta que recebeu.',
        atencao: "A última parcela quita o crédito e o plano.",
      },
    ],
  },
  "/imoveis": {
    titulo: "Cadastro imobiliário",
    resumo: "Os imóveis do município — a base do IPTU e do ITBI.",
    passos: [
      {
        acao: "Cadastrar",
        como: "Inscrição imobiliária, proprietário e valor venal.",
        atencao: "Sem imóvel cadastrado não há em que lançar IPTU.",
      },
      {
        acao: "Conceder imunidade ou isenção",
        como: "Botão de benefício, com o motivo.",
        atencao:
          "O imóvel com benefício deixa de entrar no lançamento em lote.",
      },
    ],
  },

  // --- Tesouraria e contabilidade --------------------------------------------
  "/tesouraria": {
    titulo: "Tesouraria",
    resumo: "Contas de caixa e banco, e o que entra e sai de cada uma.",
    passos: [
      {
        acao: "Cadastrar conta",
        como: 'Botão "Nova conta": nome, tipo (caixa ou banco) e dados bancários.',
        atencao:
          "É pré-requisito de toda a movimentação de dinheiro — arrecadação e pagamento. Cadastre antes de operar.",
      },
      {
        acao: "Lançar movimento",
        como: "Ingresso ou saída avulsos, com histórico.",
        atencao: "A saída nunca deixa o saldo negativo.",
      },
      {
        acao: "Transferir",
        como: "Entre duas contas do ente, num ato só.",
      },
      {
        acao: "Conciliar",
        como: 'Botão "Conciliar" na conta: informe a data e o saldo do extrato bancário.',
        atencao:
          "A diferença registrada é extrato − livro. Uma conciliação por conta e data.",
      },
    ],
  },
  "/contabilidade": {
    titulo: "Contabilidade",
    resumo: "Plano de contas e roteiros de escrituração.",
    passos: [
      {
        acao: "Definir o roteiro",
        como: "Para cada evento (empenho, liquidação, pagamento, arrecadação…), informe a conta de débito e a de crédito.",
        atencao:
          "Sem roteiro o fato acontece mas não vira lançamento — e os balanços nascem zerados. Configure antes de operar.",
      },
    ],
  },
  "/balancos": {
    titulo: "Balanços",
    resumo: "Orçamentário, financeiro, patrimonial e fluxos de caixa.",
    passos: [
      {
        acao: "Consultar",
        como: "Escolha o exercício. O balanço patrimonial traz o selo de conferência (ativo = passivo + PL).",
        atencao:
          'Se vier "Não fecha", há lançamento faltando ou roteiro contábil mal configurado.',
      },
    ],
  },

  // --- Contratações ----------------------------------------------------------
  "/licitacoes": {
    titulo: "Licitações",
    resumo: "O processo licitatório, da abertura à homologação.",
    passos: [
      {
        acao: "Abrir processo",
        como: "Número, modalidade, objeto e valor estimado.",
      },
      {
        acao: "Registrar propostas e homologar",
        como: "Lance as propostas, escolha a vencedora e homologue.",
        atencao:
          "Só licitação homologada pode originar contrato ou ata de registro de preços.",
      },
    ],
  },
  "/contratos": {
    titulo: "Contratos",
    resumo: "Contratos administrativos, itens, aditivos e medições.",
    passos: [
      {
        acao: "Cadastrar",
        como: "Número, fornecedor, objeto, modalidade, valor e vigência.",
      },
      {
        acao: "Detalhar em itens",
        como: 'Painel "Itens e aditivos" → botão "Item".',
        atencao: "A soma dos itens não pode passar do valor do contrato.",
      },
      {
        acao: "Aditar",
        como: 'Painel "Itens e aditivos" → botão "Aditivo". Valor, prazo ou ambos.',
        atencao:
          "O limite é 25% do valor ORIGINAL, acumulado entre aditivos (Lei 14.133 art. 125).",
      },
      {
        acao: "Cancelar item ou aditivo",
        como: 'Botão "Cancelar" na linha, com o motivo.',
        atencao:
          "O registro não some: fica riscado, com o motivo. O que volta é a cota que ele ocupava. Só o último aditivo vigente é cancelável.",
      },
      {
        acao: "Medir",
        como: 'Botão "Medir": a medição atestada é o que autoriza o pagamento.',
      },
      {
        acao: "Vincular à licitação",
        como: "No painel de detalhes. Só processo homologado e da mesma modalidade aparece na lista.",
      },
    ],
  },
  "/atas": {
    titulo: "Atas de registro de preços",
    resumo: "Preços registrados e as adesões (carona) que consomem o saldo.",
    passos: [
      {
        acao: "Registrar",
        como: "Escolha a licitação homologada, o fornecedor, a vigência e os itens.",
        atencao:
          "Se a lista de licitações vier vazia, nenhuma foi homologada ainda.",
      },
      {
        acao: "Consumir",
        como: "Botão de consumo no item, pela quantidade.",
        atencao: "O consumo nunca passa da quantidade registrada.",
      },
      {
        acao: "Encerrar ou cancelar",
        como: "Botão na ata. A ação é definitiva e fecha novos consumos.",
      },
    ],
  },

  // --- Materiais e patrimônio -------------------------------------------------
  "/almoxarifado": {
    titulo: "Almoxarifado",
    resumo: "Itens de material, entradas, saídas e inventário.",
    passos: [
      {
        acao: "Cadastrar item",
        como: "Código, nome, unidade, categoria e estoque mínimo.",
      },
      {
        acao: "Movimentar",
        como: "Entrada ou saída, com quantidade, valor unitário e histórico.",
        atencao: "A saída não pode passar do saldo em estoque.",
      },
      {
        acao: "Ajustar por inventário",
        como: "Informe a quantidade contada; o sistema lança a diferença.",
      },
      {
        acao: "Incorporar ao patrimônio",
        como: "Para material permanente: gera o bem com número de tombamento.",
      },
    ],
  },
  "/patrimonio": {
    titulo: "Patrimônio",
    resumo: "Bens, depreciação, reavaliação e baixa.",
    passos: [
      {
        acao: "Cadastrar bem",
        como: "Tombamento, descrição, data de aquisição, valor e vida útil.",
      },
      {
        acao: "Depreciar",
        como: "Rodada mensal de depreciação, por competência.",
      },
      {
        acao: "Reavaliar",
        como: "Novo valor justo, com laudo. Gera ganho ou perda, sem sair do acervo.",
      },
      {
        acao: "Dar baixa",
        como: "Alienação, inservibilidade ou perda, com o motivo.",
        atencao:
          "A baixa contabiliza a depreciação acumulada e o valor líquido. É definitiva.",
      },
    ],
  },

  // --- Controle e transparência ----------------------------------------------
  "/protocolo": {
    titulo: "Protocolo",
    resumo: "Processos administrativos e sua tramitação.",
    passos: [
      {
        acao: "Abrir processo",
        como: "Assunto, interessado e documento inicial. A numeração é sequencial por ano.",
      },
      {
        acao: "Tramitar",
        como: "Envie para a unidade de destino, com despacho.",
      },
    ],
  },
  "/ouvidoria": {
    titulo: "Ouvidoria",
    resumo:
      "Manifestações do cidadão: denúncia, reclamação, sugestão, elogio, solicitação (Lei 13.460).",
    passos: [
      {
        acao: "Registrar",
        como: "Tipo, identificação do manifestante e o relato.",
      },
      {
        acao: "Responder",
        como: "Botão de resposta, dentro do prazo indicado na linha.",
      },
    ],
  },
  "/esic": {
    titulo: "e-SIC",
    resumo: "Pedidos de acesso à informação (LAI, Lei 12.527).",
    passos: [
      {
        acao: "Registrar pedido",
        como: "Identificação do solicitante e o que está sendo pedido.",
        atencao: "O prazo é de 20 dias, prorrogável por mais 10 uma única vez.",
      },
      {
        acao: "Responder, prorrogar ou indeferir",
        como: "Botões na linha do pedido. O indeferimento exige fundamento.",
      },
      {
        acao: "Julgar recurso",
        como: "Aba de recursos: provido ou improvido, com a decisão.",
      },
    ],
  },
  "/controle-interno": {
    titulo: "Controle interno",
    resumo: "Apontamentos de auditoria e o acompanhamento das recomendações.",
    passos: [
      {
        acao: "Abrir apontamento",
        como: "Achado, recomendação, responsável e prazo.",
      },
      {
        acao: "Acompanhar",
        como: "Aberto → em implementação → implementado (ou não implementado).",
      },
    ],
  },
  "/transparencia": {
    titulo: "Portal da Transparência",
    resumo: "Execução da despesa e da receita publicadas (LAI / LC 131).",
    passos: [
      {
        acao: "Consultar",
        como: "Escolha o exercício. Os números vêm da execução, não de digitação.",
      },
      {
        acao: "Baixar dados abertos",
        como: 'Botão "Dados abertos (JSON)".',
      },
    ],
  },
};

/** Ajuda da rota, ou `null` quando a tela ainda não tem roteiro escrito. */
export function ajudaDaRota(pathname: string): AjudaDeTela | null {
  if (AJUDA[pathname]) return AJUDA[pathname];
  // Rota com parâmetro (/rh/funcionarios/123) cai na tela-mãe.
  const partes = pathname.split("/").filter(Boolean);
  while (partes.length > 1) {
    partes.pop();
    const pai = "/" + partes.join("/");
    if (AJUDA[pai]) return AJUDA[pai];
  }
  return null;
}
