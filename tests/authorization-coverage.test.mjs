/**
 * Cobertura de autorização das server functions (O0-08).
 *
 * A autorização de tenant é 100% aplicacional e fail-open por omissão: um handler
 * que recebe `tenant_id` e esquece de validar o ente abre o tenant inteiro, e
 * nada avisa. Este check estático — não um teste de comportamento — varre por AST
 * (compiler API do TypeScript) cada `createServerFn` em src/lib/*.functions.ts e
 * exige que o corpo do handler alcance um primitivo de autorização, direto ou por
 * um helper local. As exceções legítimas (auth, OCR, admin legado, self-service)
 * ficam numa ALLOWLIST explícita e auditável. Um handler novo fora dos dois casos
 * quebra o CI.
 *
 * É uma rede de conformidade, como uma regra de lint — complementa, não substitui,
 * os testes de comportamento.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const libDir = join(root, "src", "lib");

// Primitivos de autorização reconhecidos como cobertura. loadTenantUnitScope
// chama requireTenantPermission por dentro; withTenant reúne os dois.
const AUTH_PRIMITIVES = new Set([
  "loadTenantAccess",
  "withTenant",
  "loadTenantUnitScope",
]);

/**
 * Exceções legítimas: handlers que, por natureza, não validam tenant. Cada
 * entrada exige uma razão. O teste falha se uma entrada aqui não corresponder a
 * nenhum export real (allowlist morta) — para não acumular exceções fantasmas.
 */
const ALLOWLIST = {
  // Autenticação e query genérica — rodam antes/fora do contexto de tenant.
  signUp: "cadastro, antes de existir sessão/tenant",
  signIn: "login, antes de existir sessão/tenant",
  signOutSession: "encerra a própria sessão",
  dbQuery:
    "valida o tenant por dentro (loadTenantAccess condicional) desde O0-06",
  storageUpload: "self-service: escopo pela própria pasta do userId",
  storageDownload: "self-service: escopo pela própria pasta do userId",
  // Admin global legado — autoriza por papel admin (user_roles). Migra no O0-10.
  adminCreateUser: "admin global legado (O0-10)",
  adminResetPassword: "admin global legado (O0-10)",
  adminUpdateUserEmail: "admin global legado (O0-10)",
  adminDeleteUser: "admin global legado (O0-10)",
  rhUploadEmployeeDocument: "admin/RH legado sobre documento (O0-10)",
  getEmailSettings: "config SMTP global, guardada por requireAdmin",
  saveEmailSettings: "config SMTP global, guardada por requireAdmin",
  sendTestEmail: "config SMTP global, guardada por requireAdmin",
  // Contexto e criação de ente.
  getTenantContext: "carregador do próprio contexto de tenant do usuário",
  createTenant: "cria o ente; autoriza por admin global legado",
  // Self-service (dados do próprio usuário).
  getMyFinancialPortal: "lê os próprios vínculos por context.userId",
  // MFA do próprio usuário — identidade, sem contexto de tenant (O0-09).
  getMfaStatus: "MFA do próprio usuário, sem tenant",
  startMfaEnrollment: "MFA do próprio usuário, sem tenant",
  confirmMfaEnrollment: "MFA do próprio usuário, sem tenant",
  verifyMfa: "MFA do próprio usuário, sem tenant",
  disableMfa: "MFA do próprio usuário, sem tenant",
  // OCR: utilitários sem estado, sem dados de tenant.
  extractAtestadoOCR: "proxy de OCR sem estado, sem dados de tenant",
  extractDocumentoOCR: "proxy de OCR sem estado, sem dados de tenant",
};

/** Nome do identificador chamado, pegando o mais à direita (x.y() -> "y"). */
function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** Todos os nomes de função chamados dentro de um nó (recursivo). */
function calledNames(node) {
  const names = new Set();
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name) names.add(name);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

/** Coleta os handlers exportados e os helpers autorizadores de um arquivo. */
function analyzeFile(path) {
  const src = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const handlers = []; // { name, body }
  const helperBodies = new Map(); // nome -> nó do corpo (funções do arquivo)

  const findHandlerArg = (initializer) => {
    // Caminha a cadeia createServerFn(...).middleware(...).handler(ARG).
    let found = null;
    const visit = (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "handler" &&
        n.arguments.length
      ) {
        found = n.arguments[0];
      }
      ts.forEachChild(n, visit);
    };
    visit(initializer);
    return found;
  };

  const visit = (node) => {
    // Declarações de função de nível de arquivo (helpers).
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      helperBodies.set(node.name.text, node.body);
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const name = decl.name.text;
        const init = decl.initializer;
        // Helper: const x = async (...) => { ... } ou function expression.
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          helperBodies.set(name, init.body);
        }
        // Handler exportado: createServerFn em algum ponto da cadeia.
        const isExported = node.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (isExported && calledNames(init).has("createServerFn")) {
          const handlerArg = findHandlerArg(init);
          if (handlerArg) handlers.push({ name, body: handlerArg });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);

  // Helpers autorizadores: os que chamam um primitivo de autorização.
  const authorizerHelpers = new Set();
  for (const [name, body] of helperBodies) {
    const called = calledNames(body);
    if ([...called].some((c) => AUTH_PRIMITIVES.has(c))) {
      authorizerHelpers.add(name);
    }
  }

  return { handlers, authorizerHelpers };
}

test("todo createServerFn de tenant passa por um guard de autorização", () => {
  const files = readdirSync(libDir)
    .filter((f) => f.endsWith(".functions.ts"))
    .map((f) => join(libDir, f));

  const uncovered = [];
  const seenExports = new Set();

  for (const file of files) {
    const { handlers, authorizerHelpers } = analyzeFile(file);
    const covered = new Set([...AUTH_PRIMITIVES, ...authorizerHelpers]);
    for (const h of handlers) {
      seenExports.add(h.name);
      if (h.name in ALLOWLIST) continue;
      const called = calledNames(h.body);
      const ok = [...called].some((c) => covered.has(c));
      if (!ok) {
        uncovered.push(`${h.name} (${file.replace(root + "/", "")})`);
      }
    }
  }

  assert.deepEqual(
    uncovered,
    [],
    `Handlers sem verificação de tenant e fora da allowlist:\n  ${uncovered.join(
      "\n  ",
    )}\nAdicione loadTenantAccess/withTenant ao handler, ou justifique na ALLOWLIST.`,
  );

  // Allowlist morta: toda entrada tem de corresponder a um export real.
  const dead = Object.keys(ALLOWLIST).filter((k) => !seenExports.has(k));
  assert.deepEqual(
    dead,
    [],
    `Entradas da ALLOWLIST que não correspondem a nenhum export atual: ${dead.join(
      ", ",
    )}`,
  );
});
