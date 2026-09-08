# ADR 0014 — Aposentar a ponte legada de permissões por reconciliação + flag

Status: aceito (Incremento 1).

## Contexto

`loadTenantAccess` resolvia as permissões do RBAC por tenant e, **por cima**,
unia permissões a partir das tabelas legadas **globais** `user_roles`/
`rh_permissions` (a "ponte"). O efeito grave: um `admin` legado recebia o
catálogo inteiro em **todo** tenant do qual é membro — escalação de privilégio
entre entes. Deletar a ponte de uma vez, porém, reduziria o RH legado: a ponte
concede a ele 47 permissões (o catálogo exceto `tenant.manage`,
`security.manage`, `audit.read`), mas o papel RBAC mapeado (`sector_manager`)
carrega bem menos.

## Decisão

Aposentar a ponte em incrementos, começando por **reconciliar** o que ela
concede em papéis RBAC reais e **instrumentar** a dependência antes de desligar:

1. **Migration de reconciliação** cria, por tenant, o papel de sistema
   `rh_operador` com exatamente as 47 permissões da união legada do RH
   (`security_permissions` exceto os 3 códigos que o RH nunca teve), reafirma
   `tenant_admin` com o catálogo inteiro e faz backfill de `rh_operador` para
   todo usuário `rh` legado com associação ativa. **Sem backfill de admin** —
   reproduziria a escalação.
2. **Flag `LEGACY_ROLE_BRIDGE`** (default `on`) gira a união legada.
   `loadTenantAccess` calcula o conjunto da ponte à parte e emite telemetria
   (`LEGACY_BRIDGE_DEPENDENCY`) sempre que a ponte concederia algo que o RBAC não
   concede — ligada ou desligada — tornando o flip para `off` observável.
3. **Provisionamento** de RH novo passa a atribuir `rh_operador` (não
   `sector_manager`), para não nascer dependente da ponte.

O papel escolhido é **novo (`rh_operador`)**, não uma ampliação de
`sector_manager`: ampliar daria fechamento de folha, `esocial.manage` e
`migration.manage` a todo gestor setorial nativo — regressão de mínimo
privilégio.

## Consequências

- Neste deploy **ninguém perde acesso** (ponte segue `on`); a telemetria começa a
  medir a dependência real.
- Fechar a escalação do admin é uma etapa **só de env** (`LEGACY_ROLE_BRIDGE=off`)
  depois que a telemetria zerar — rollback instantâneo pela mesma variável.
- A reconciliação é aditiva e idempotente; `rh_operador` acompanha o catálogo por
  usar `not in (...)`, não uma lista fixa.

## Fora de escopo (follow-ups)

- **Gates de admin global** (`adminCreateUser`, `adminResetPassword`, …,
  `requireAdmin` do SMTP) autorizam por admin **global** e fazem atos
  cross-system; migrá-los exige um conceito de _platform admin_ próprio
  (O0-10b).
- **`pgrest.policyFor`** (motor de política do shim) — aposentadoria do shim,
  Onda 2.
- **Incremento 2** (env `off` + remover o curto-circuito `isAdmin ||` de
  `hasTenantPermission` no cliente) e **Incremento 3** (deletar o bloco da ponte
  e migrar o `hasPermission` legado do menu, `AppShell.tsx` por último).

## Alternativas descartadas

- **Deletar a ponte agora** — reduziria o RH legado de 47 → poucas permissões e
  poderia travar operações reais sem aviso.
- **Ampliar `sector_manager`** — regressão de mínimo privilégio para gestores
  setoriais nativos.
- **Backfill de `admin` → `tenant_admin` em todos os entes** — materializaria a
  própria escalação cross-tenant que O0-10 remove.
