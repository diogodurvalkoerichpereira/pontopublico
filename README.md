# pontopublico

Sistema de **RH, folha de pagamento e ponto** para o setor público brasileiro,
em evolução para um ERP de gestão pública integrada.

Web (TanStack Start + React 19) sobre PostgreSQL, multi-tenant, com trilha de
auditoria e cálculo de folha por fórmulas versionadas e auditáveis.

## Estado atual — sem maquiagem

Leia isto antes de assumir o que o produto faz.

**Funciona e tem qualidade de produção:** RBAC multi-tenant com escopo por
unidade, cadastro de pessoas e vínculos, catálogo de rubricas versionado, motor
de fórmulas de folha, e o ciclo de folha com segregação de funções, aprovação e
fechamento.

**É roadmap, não presente:** o ERP de gestão pública (orçamento, contabilidade
PCASP, tesouraria, tributação, materiais, transparência). Ver
[`ROADMAP_GESTAO_PUBLICA.md`](ROADMAP_GESTAO_PUBLICA.md).

**Não está implementado, apesar de haver código com esse nome:**

- **eSocial** — a fila existe, mas não há geração de XML, assinatura nem
  transmissão. A função de processamento falha de propósito.
- **Remessa bancária** — gera um formato próprio, **não** CNAB 240.
- **Exportações para TCE/SIOPE** — geram um CSV genérico, **não** os layouts
  oficiais.

Esses três levam o prefixo `RASCUNHO_` e estão registrados em
[`src/lib/conformance.ts`](src/lib/conformance.ts). **Não os declare como
conformes em nenhuma licitação.**

## Como rodar

Pré-requisitos: **Node 22+** e **Docker** (ou um PostgreSQL 13+ próprio).

```bash
# 1. Dependências
npm ci

# 2. Configuração
cp .env.example .env
```

Edite o `.env`:

- **`POSTGRES_PASSWORD`** e a senha dentro de **`DATABASE_URL`** têm de ser
  **iguais** — o Docker cria o usuário com a primeira, a aplicação conecta com a
  segunda.
- **`SESSION_SECRET`** precisa de ≥32 caracteres. Gere um:
  ```bash
  node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
  ```
- **`MFA_ENC_KEY`** cifra o segredo TOTP em repouso (AES-256-GCM). ≥32
  caracteres; ideal 32 bytes em base64. Configure-a **antes** do primeiro uso do
  segundo fator; trocá-la depois invalida os segredos já cadastrados. Gere:
  ```bash
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
  ```
- **`ADMIN_EMAILS`** — o e-mail que você vai cadastrar. **É o único caminho para
  ter acesso administrativo**: quem se cadastra com um e-mail desta lista vira
  admin. Sem isso, o banco novo não tem administrador.

```bash
# 3. Subir o banco (postgres:17-alpine em 127.0.0.1:5433)
npm run db:up

# 4. Aplicar o esquema — ANTES de subir a aplicação
npm run db:migrate
npm run db:status        # deve imprimir "pendentes: 0"

# 5. Rodar em desenvolvimento
npm run dev              # http://localhost:8080
```

> **A ordem importa.** A aplicação sobe mesmo sem o esquema aplicado — a home
> responde 200, por isso ela serve de healthcheck —, mas a falha só aparece ao
> tentar logar. Rode `db:migrate` antes de `dev`.

Verificar que está tudo de pé:

```bash
npm test                 # testes de comportamento (node:test)
npm run db:dryrun        # replay do esquema em PGlite; gate de mudança em SQL
```

## Comandos

| Comando                  | O que faz                                            |
| ------------------------ | ---------------------------------------------------- |
| `npm run dev`            | Desenvolvimento na porta 8080                        |
| `npm run build`          | Build de produção (emite `.output/server/index.mjs`) |
| `npm start`              | Roda o build — exige `npm run build` antes           |
| `npm test`               | Testes reais em `tests/**/*.test.mjs`                |
| `npm run typecheck`      | `tsc --noEmit`                                       |
| `npm run lint`           | ESLint                                               |
| `npm run format`         | Prettier (escreve)                                   |
| `npm run db:up`          | Sobe o PostgreSQL de desenvolvimento via Docker      |
| `npm run db:migrate`     | Aplica bootstrap + migrations (ledger com checksum)  |
| `npm run db:status`      | Lista migrations pendentes sem aplicar               |
| `npm run db:dryrun`      | Replay do esquema inteiro em PGlite, sem Docker      |
| `npm run quality:check`  | Catraca: falha se erros de tipo/lint subirem         |
| `npm run quality:update` | Regrava o teto da catraca (após reduzir erros)       |

## Mapa de pastas

```
src/
  routes/          telas (roteamento por arquivo do TanStack Router)
  lib/
    *.functions.ts server functions (RPC) — a lógica de negócio
    *.server.ts    código só-servidor; nunca importar do cliente
    *.ts           código isomórfico (motor de fórmulas, utils)
  components/      AppShell + primitivos shadcn/ui
  integrations/    shim que imita o supabase-js sobre o PG próprio (ver CLAUDE.md)
supabase/migrations/  esquema versionado (imutável após aplicado)
db/bootstrap/         compat de PostgreSQL puro, reaplicado a cada migrate
scripts/              migrator, dry-run, catraca, validadores
tests/                testes reais (node:test)
docs/                 arquitetura, glossário, conformidade, ADRs, histórico
```

## Para onde ir depois

| Você quer…                                  | Leia                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| Contribuir ou usar um agente aqui           | [`CLAUDE.md`](CLAUDE.md) — regras invioláveis            |
| Saber o que fazer a seguir                  | [`BACKLOG.md`](BACKLOG.md)                               |
| Entender a estratégia de evolução           | [`ROADMAP_GESTAO_PUBLICA.md`](ROADMAP_GESTAO_PUBLICA.md) |
| Entender a arquitetura                      | [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md)             |
| Traduzir os termos de contabilidade pública | [`docs/GLOSSARIO.md`](docs/GLOSSARIO.md)                 |
| Ver o que atende a editais                  | [`docs/CONFORMIDADE.md`](docs/CONFORMIDADE.md)           |
| Entender uma decisão de projeto             | [`docs/adr/`](docs/adr/)                                 |
