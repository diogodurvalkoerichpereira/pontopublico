# ADR 0013 — MFA (TOTP) restrito a operações de alto risco, uma vez por sessão

Status: aceito.

## Contexto

Atos irreversíveis — fechar/reabrir folha, administrar papéis de segurança e
entidades — dependiam só da senha. Segundo fator é item pontuável em edital de
software público e defesa básica desses atos. O catálogo já tem
`security_permissions.criticidade` (`normal|sensivel|critica`), mas há **~19
permissões `critica`**, muitas de rotina do RH (`people.manage`,
`payroll.simulate`); exigir MFA em todas tornaria o segundo fator onipresente no
dia a dia.

## Decisão

MFA TOTP (RFC 6238) obrigatório para um **conjunto restrito e explícito** de 4
permissões — `security.manage`, `tenant.manage`, `payroll.cycles.close`,
`payroll.cycles.reopen` (`PROTECTED_MFA_PERMISSIONS`) — e **não** para todas as
`critica`. Verificação **uma vez por sessão**: `verifyMfa` carimba
`private.auth_sessions.mfa_verified_at` e a sessão segue MFA-backed pelo resto da
vida dela (24 h), sem re-prompt por operação. O segredo TOTP é cifrado em repouso
com **AES-256-GCM** sob a chave dedicada `MFA_ENC_KEY`, fora do banco.

## Consequências

- O guard `requireCriticalMfa(permission, mfaVerifiedAt)` é fail-closed e chamado
  à mão logo após `requireTenantPermission` nos handlers protegidos — mesma
  disciplina do par `loadTenantAccess`/`requireTenantPermission` (ver CLAUDE.md).
  Esquecê-lo num handler novo protegido não é pego pelo teste de cobertura de
  tenant; a lista de sites é curta e auditável de propósito.
- `MFA_ENC_KEY` entra no rol de segredos obrigatórios de produção (como
  `SESSION_SECRET`): configurar no Coolify antes do deploy. Trocá-la torna
  ilegíveis os segredos já cadastrados — o usuário recadastra o MFA.
- Ampliar o conjunto protegido é acrescentar um código a uma constante; não exige
  migration nem tocar o catálogo `criticidade`.

## Por quê

Ler `criticidade` do catálogo por operação acoplaria o gate ao dado e arrastaria
MFA para rotina. Uma constante de 4 códigos é explícita, testável por mutação e
desacoplada. "Uma vez por sessão" equilibra proteção e atrito: o ato de alto
risco pede o fator, o resto da sessão não.

## Alternativas descartadas

- **MFA em todo login, para todos os usuários** — atrito desproporcional ao risco
  da maioria dos perfis; o edital pede segundo fator em atos privilegiados, não
  ubíquo.
- **MFA em todas as permissões `critica`** — onipresente no dia a dia do RH, o
  problema que esta decisão evita.
- **WebAuthn/passkeys** — atende, mas TOTP já cobre o segundo fator do edital com
  `node:crypto` e sem dependência nova; passkeys ficam para depois.
- **Cifrar o segredo com `SESSION_SECRET`** — mistura o segredo de sessão com o de
  dados em repouso; chave dedicada permite rotação independente.
