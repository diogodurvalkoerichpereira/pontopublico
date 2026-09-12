# ADR 0012 — Manter o shim Supabase deliberadamente

Status: aceito.

## Contexto

`src/integrations/supabase/client.ts` **imita** o supabase-js (`.from().select()
.eq()`, `auth`, `storage`) mas roda sobre o PostgreSQL próprio via server
functions. É herança da geração hospedada no Supabase, preservada numa migração
para self-hosted que não reescreveu as ~15 telas que o consomem. No mesmo
diretório, `client.server.ts` e `auth-middleware.ts` são Supabase real, e são
código morto.

## Decisão

Manter o shim por ora, como estratégia de migração incremental, e aposentá-lo
telas-a-telas (backlog O0-06, O0-13). **Não** trocá-lo pelo `@supabase/supabase-js`
real.

## Consequências

- As telas legadas continuam funcionando sem reescrita imediata.
- O shim é o principal foco de risco de isolamento de tenant (não tem noção de
  tenant) e por isso é o alvo de O0-06.
- Custo cognitivo permanente: quem lê `import { supabase }` pensa que há Supabase.
  Este ADR e o CLAUDE.md existem para neutralizar isso.

## Por quê

Trocar o shim pelo pacote real quebra a aplicação inteira — o shim não fala com
Supabase nenhum, fala com o PostgreSQL próprio. E reescrever as 15 telas de uma
vez é semanas de risco em código sem teste. Aposentar por partes é mais seguro.

## Alternativa descartada

Substituir o shim pelo supabase-js "de verdade" — não há Supabase por trás;
quebra tudo.
