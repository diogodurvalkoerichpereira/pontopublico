# CLAUDE.md — guia para agentes e contribuidores

Leia este arquivo antes de tocar no código. Ele existe porque várias decisões
deste projeto são contraintuitivas, e desfazê-las por desconhecimento custa caro.

## Em três linhas

`pontopublico` é RH/folha/ponto para o setor público, evoluindo para ERP de
gestão pública. Stack: TanStack Start (Nitro node-server) + React 19 +
PostgreSQL puro via `pg`. Autorização é 100% aplicacional; toda a segurança
depende de você seguir o padrão de server function abaixo.

## Comandos essenciais

`npm run dev` · `npm test` · `npm run db:dryrun` (gate de qualquer mudança em
SQL) · `npm run quality:check` (catraca) · `npm run db:migrate`. Ver
[README.md](README.md) para o setup completo.

## Arquivos para imitar

Ao criar algo novo, copie a estrutura destes:

| Você vai criar…                         | Modele por                                                             |
| --------------------------------------- | ---------------------------------------------------------------------- |
| Server function com fluxo de estados    | `src/lib/payroll-cycle.functions.ts`                                   |
| Módulo de leitura tipado, com auditoria | `src/lib/audit.functions.ts`                                           |
| Migration                               | `supabase/migrations/20260816150000_sprint1_multi_tenant_security.sql` |
| Teste de verdade                        | `tests/pgrest-guards.test.mjs`                                         |

## Padrão de server function — a espinha da segurança

Toda função de servidor segue esta cadeia, **sem exceção**:

```ts
export const minhaFn = createServerFn({ method: "POST" })
  .middleware([requireAuth]) // injeta { userId, email }
  .validator((v: unknown) => Schema.parse(v)) // zod
  .handler(async ({ data, context }) => {
    const a = await loadTenantAccess(context.userId, data.tenant_id);
    requireTenantPermission(a, "modulo.acao"); // NÃO PODE FALTAR
    return query(`... where tenant_id = $1 ...`, [data.tenant_id /* ... */]);
  });
```

A autorização **não** é imposta pelo banco (RLS está inerte no caminho real — é
decisão consciente, ver `docs/adr/`). É imposta por essas duas linhas
—`loadTenantAccess` + `requireTenantPermission`— chamadas à mão em cada handler.
Isso é **fail-open por omissão**: esquecer as duas linhas num handler novo abre o
tenant inteiro. Toda consulta filtra por `tenant_id`.

Prefira o invólucro `withTenant`, que reúne as duas numa chamada:

```ts
.handler(({ data, context }) =>
  withTenant(context.userId, data.tenant_id, "modulo.acao", async (access) => {
    return query(`... where tenant_id = $1 ...`, [data.tenant_id]);
  }),
);
```

`tests/authorization-coverage.test.mjs` é a rede: varre por AST todo
`createServerFn` em `src/lib/*.functions.ts` e **falha o CI** se um handler não
alcançar um guard (`loadTenantAccess`, `withTenant` ou `loadTenantUnitScope`,
direto ou por helper local). Exceção legítima (auth, self-service, OCR, admin
legado) vai na `ALLOWLIST` do teste, com uma razão de uma linha — nunca deixe um
handler de tenant fora das duas coisas.

## Regras invioláveis

Cada uma tem um motivo. Regra sem motivo é revogada na primeira pressa — por isso
o motivo está aqui.

| Regra                                                                                                                                                                                   | Por quê                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Migration aplicada é imutável.** Mudou algo? Crie uma nova.                                                                                                                           | `scripts/db-migrate.mjs` guarda checksum SHA-256 por arquivo e **aborta** se um já aplicado mudar. Editar quebra o ledger em toda instalação existente.                                                              |
| **Migration nova: legível, uma instrução por linha.**                                                                                                                                   | As das Sprints 12+ são minificadas numa linha só; foi assim que a Sprint 19 passou verde com erro de sintaxe e a 13 com coluna inexistente.                                                                          |
| **`ALTER TYPE … ADD VALUE` e o uso do valor vão em migrations separadas.**                                                                                                              | Precisam de transações distintas. O migrator não envelopa arquivos que já têm `begin;` próprio; um `BEGIN` no meio do arquivo quebra a atomicidade **em silêncio**.                                                  |
| **Todo handler novo: `requireAuth` + `loadTenantAccess` + `requireTenantPermission`.**                                                                                                  | Ver acima. Fail-open por omissão.                                                                                                                                                                                    |
| **`*.server.ts` nunca é importado do cliente.**                                                                                                                                         | É a barreira servidor/cliente. O ESLint reforça parcialmente (`no-restricted-imports`).                                                                                                                              |
| **`@/integrations/supabase/client` NÃO é o supabase-js.** Não o "conserte" importando o pacote real.                                                                                    | É um shim local de ~380 linhas sobre o PostgreSQL próprio. No mesmo diretório, `client.server.ts` e `auth-middleware.ts` são código morto que lê `SUPABASE_*`. Trocar o shim pelo pacote quebra a aplicação inteira. |
| **Não edite `src/routeTree.gen.ts`, `src/integrations/supabase/*`, nem adicione plugins a `vite.config.ts`.**                                                                           | Os dois primeiros são gerados. O preset do Vite já inclui os plugins; duplicá-los quebra o app (o cabeçalho do arquivo avisa).                                                                                       |
| **Nenhum artefato leva nome de padrão oficial sem homologação.**                                                                                                                        | Ver `src/lib/conformance.ts`. Em licitação, um arquivo "CNAB240" que não é CNAB 240 vira declaração falsa de conformidade.                                                                                           |
| **Não aumente o teto da catraca.** Ao reduzir erros, rode `npm run quality:update` e commite `quality-baseline.json`.                                                                   | `quality-baseline.json` fixa o débito herdado (274 tipos, ~2022 lint) para que não cresça. Cada correção baixa o teto para sempre.                                                                                   |
| **Teste que lê arquivo como string não é teste.**                                                                                                                                       | Foi o que deixou 13 sprints sem cobertura. Um teste executa o código e afere o comportamento — ver `tests/pgrest-guards.test.mjs`.                                                                                   |
| **Nada de prefixo `VITE_` em segredo.**                                                                                                                                                 | O preset injeta `VITE_*` no bundle do cliente; o valor fica público.                                                                                                                                                 |
| **Idioma:** comentários, mensagens e rotas em português; identificadores e nomes de tabela em inglês (`employment_links`, `payroll_cycles`). Títulos de commit em português sem acento. | Convenção real do código, nunca antes escrita.                                                                                                                                                                       |

## Gotchas que custam horas

- **`db:migrate` antes de `dev`.** A app sobe sem banco; a falha só aparece ao logar.
- **`SESSION_SECRET` ≥32 caracteres**, senão `auth.server.ts` lança na subida.
- **Sem seed.** O primeiro admin nasce de `ADMIN_EMAILS` no cadastro.
- **SMTP vive na tabela `email_settings`**, não em variável de ambiente.
- **`TZ`/tzdata**: sem tzdata, `TZ=America/Sao_Paulo` cai em UTC em silêncio — erro de competência em folha. O `Dockerfile` já instala; ambiente local precisa ter.
- **`routeTree.gen.ts` pode estar desatualizado** em relação às rotas em `src/routes/`; ele é regenerado pelo dev server.

## Definição de Pronto

Um item só está pronto quando tem, todos:

1. Código + migration (quando aplicável).
2. **Um teste que falha sem a mudança** — verificado removendo a mudança.
3. Catraca estável (`npm run quality:check` verde) e CI verde.
4. Documentação afetada atualizada (este arquivo, README, BACKLOG, ADR).
5. **Para módulo de integração** (banco, TCE, eSocial, NFS-e, PNCP): aceite pelo
   sistema oficial correspondente **antes** de qualquer declaração de
   conformidade. Nunca contra mock próprio — foi a ausência disso que produziu os
   três módulos-fachada.
