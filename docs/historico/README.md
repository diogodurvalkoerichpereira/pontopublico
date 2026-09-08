# Histórico das Sprints 1–20

> ⚠️ **Documentos desatualizados. Não use como referência do estado atual.**

Estes arquivos registram o processo de desenvolvimento das Sprints 1 a 20
(agosto/2026). São mantidos pelo valor histórico — em especial as entregas das
Sprints 1 a 6, que são a única explicação em prosa de por que o modelo
multi-tenant e o ciclo de folha ficaram como estão.

**Várias afirmações aqui foram contraditadas por auditoria posterior.** Em
particular:

- `RELATORIO_AVANCO_APOS_SPRINT20.md` declara 92,2% concluído e afirma que
  "controles de tenant, permissões e RLS foram revisados". A auditoria feita
  para o roadmap encontrou o oposto: RLS inerte no caminho real, isolamento de
  tenant furado e três módulos (eSocial, remessa CNAB, exportações oficiais) que
  levavam nomes de padrões oficiais sem os implementar.
- O percentual mede código escrito, não sistema funcionando. As migrations só
  foram aplicadas em um PostgreSQL real pela primeira vez durante a Onda 0 de
  saneamento — não durante as sprints.
- Os relatórios citam um "backlog da Etapa 1 com 22 épicos e 102 pontos" como
  fonte. Esse documento **nunca existiu no repositório**. Seu lugar é ocupado
  agora por `BACKLOG.md` na raiz.

## Onde está a documentação viva

| Assunto                              | Documento                          |
| ------------------------------------ | ---------------------------------- |
| Como rodar o projeto                 | `README.md` (raiz)                 |
| Regras para contribuir / agentes     | `CLAUDE.md` (raiz)                 |
| O que fazer a seguir                 | `BACKLOG.md` (raiz)                |
| Estratégia de evolução               | `ROADMAP_GESTAO_PUBLICA.md` (raiz) |
| Arquitetura, glossário, conformidade | `docs/`                            |
| Decisões e o porquê                  | `docs/adr/`                        |
