# Entrega da Sprint 4 — segurança, fórmulas e simulação da folha

Data: 17/08/2026  
Escopo: HU02.06, HU04.03, HU04.05 e HU04.06.

## Resultado implementado

- política de senha com mínimo de 12 caracteres, maiúscula, minúscula, número e símbolo;
- comparação de senha com custo equivalente mesmo quando o e-mail não existe;
- registro de falhas por identificador e IP usando somente hashes SHA-256;
- bloqueio temporário após cinco falhas consecutivas;
- sessões persistidas, revogáveis e limitadas a 24 horas;
- revogação das sessões anteriores após redefinição de senha;
- tela de login e redefinição alinhadas à nova política, sem senha padrão compartilhada;
- editor visual de fórmulas com variáveis e operadores permitidos;
- AST validada com limite de profundidade e quantidade de nós, sem `eval`, SQL dinâmico ou JavaScript do usuário;
- checksum SHA-256 canônico da fórmula;
- rejeição com caminho exato do nó inválido;
- bloqueio de alteração de fórmula, vigência e arredondamento de versão publicada;
- rubricas fixas por vínculo, com valor, quantidade, parâmetros e vigência;
- bloqueio de atribuições sobrepostas e de referências entre entidades;
- simulação por competência e seleção de vínculos, sem fechar a folha;
- snapshot das entradas, versão do motor e checksum da execução;
- memória por rubrica contendo variáveis, sequência, operações, bases, arredondamento e valor final;
- RLS, concessões explícitas, escopo organizacional e auditoria das operações críticas.

## Novas telas e evoluções

- `/rh/rubricas` — editor visual e validação da AST nas versões;
- `/rh/simulacoes` — eventos fixos, seleção de vínculos, execução e memória de cálculo;
- `/login` — política de senha forte e mensagens de bloqueio;
- redefinição administrativa — senha forte informada pelo operador e revogação das sessões anteriores.

## Aplicação em homologação

Aplicar na ordem:

1. `20260816150000_sprint1_multi_tenant_security.sql`;
2. `20260816190000_sprint2_people_scopes_audit.sql`;
3. `20260816193000_sprint3_family_movements_payroll_catalog.sql`;
4. `20260817093000_sprint4_auth_formula_assignments_simulation.sql`;
5. executar `scripts/reconcile-sprint4.sql` e arquivar o resultado.

O projeto Supabase de produção não foi alterado.

## Atenções de implantação

- os tokens anteriores à Sprint 4 não possuem `sid`; após a publicação, todos os usuários deverão entrar novamente;
- versões já publicadas sem AST precisam receber uma nova versão validada antes de serem usadas na simulação;
- configurar `SESSION_SECRET` com segredo aleatório de pelo menos 32 caracteres no ambiente;
- executar primeiro em homologação com backup e registrar o resultado da reconciliação;
- as configurações nativas de sessão do Supabase não substituem estes controles porque esta aplicação usa autenticação própria no servidor.

## Evidências automatizadas

```bash
node scripts/validate-sprint1-migration.mjs
node scripts/validate-sprint2-migration.mjs
node scripts/validate-sprint3-migration.mjs
node scripts/validate-sprint4-migration.mjs
node scripts/validate-sprint4-formula.mjs
node scripts/validate-sprint4-auth.mjs
npm run build
```

Os testes da Sprint 4 validam senha forte, assinatura adulterada, sessão de 24 horas, bloqueio após cinco falhas, AST permitida, rejeição de função/injeção, divisão por zero, HALF_UP, HALF_EVEN, fórmula obrigatória, imutabilidade publicada, vigências, isolamento por entidade e RLS das simulações.

## Gate manual de homologação

- executar cinco logins inválidos e confirmar o bloqueio da sexta tentativa;
- redefinir a senha de um usuário e confirmar que sua sessão anterior deixa de funcionar;
- tentar cadastrar senha sem todos os requisitos e confirmar a rejeição;
- validar `salário-base × 0,10` e conferir resultado, AST e checksum;
- tentar enviar nó `function`, campo extra ou divisão por zero e conferir o caminho do erro;
- publicar uma versão e confirmar que sua fórmula não pode mais ser alterada;
- atribuir a mesma rubrica com vigências sobrepostas e confirmar o bloqueio;
- simular vínculo sem rubrica vigente e confirmar resultado vazio, sem fechamento;
- simular vínculo configurado e reproduzir cada centavo usando a memória;
- conferir que proventos, descontos, bases e ordem correspondem ao cenário aprovado pelo especialista de folha;
- executar a reconciliação e exigir zero inconsistências.
