/**
 * Decisão de abrir/fechar um grupo do menu lateral.
 *
 * Módulo **puro**, separado do `AppShell`, porque foi aqui que a primeira versão
 * errou e o projeto não tem renderizador de DOM para testar o componente: a
 * regra era `!temAtivo && fechados.includes(secao)`, que forçava o grupo da
 * página aberta a ficar sempre visível. A intenção era boa — não deixar o
 * usuário perder de vista onde está —, mas o efeito era o cabeçalho desse grupo
 * **não responder ao clique**: o usuário clicava e nada acontecia, e o menu
 * parecia quebrado.
 *
 * A regra certa separa as duas coisas: o clique sempre vence; a abertura
 * automática acontece só quando a NAVEGAÇÃO entra num grupo fechado.
 */

/** Um grupo aparece fechado? Com a barra em ícones não há sanfona. */
export function grupoFechado(params: {
  barraAberta: boolean;
  secao: string;
  fechados: readonly string[];
}): boolean {
  return params.barraAberta && params.fechados.includes(params.secao);
}

/** Alterna o grupo no clique do cabeçalho. */
export function alternarGrupoFechado(
  fechados: readonly string[],
  secao: string,
): string[] {
  return fechados.includes(secao)
    ? fechados.filter((s) => s !== secao)
    : [...fechados, secao];
}

/**
 * Ao navegar: abre o grupo que contém a página aberta. Devolve a MESMA
 * referência quando nada muda, para não disparar re-render à toa.
 */
export function abrirGrupoDaNavegacao(
  fechados: readonly string[],
  secaoAtiva: string | undefined,
): readonly string[] {
  if (!secaoAtiva || !fechados.includes(secaoAtiva)) return fechados;
  return fechados.filter((s) => s !== secaoAtiva);
}
