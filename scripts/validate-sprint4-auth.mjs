import {
  assertStrongPassword,
  passwordPolicyIssues,
  signToken,
  TOKEN_TTL,
  verifyToken,
} from "../src/lib/auth.server.ts";

process.env.SESSION_SECRET = "sprint4-test-secret-with-at-least-32-characters";

const weakIssues = passwordPolicyIssues("123456");
if (weakIssues.length < 4)
  throw new Error("Política de senha fraca não foi rejeitada");
assertStrongPassword("SenhaForte#2026");

const sid = "90000000-0000-4000-8000-000000000001";
const token = signToken(
  "10000000-0000-4000-8000-000000000001",
  "admin@example.com",
  sid,
);
const claims = verifyToken(token);
if (!claims || claims.sid !== sid)
  throw new Error("Token não preservou a sessão revogável");
if (claims.exp - claims.iat !== 86_400 || TOKEN_TTL !== 86_400)
  throw new Error("Sessão não está limitada a 24 horas");
if (verifyToken(`${token}x`))
  throw new Error("Assinatura adulterada foi aceita");

console.log(
  JSON.stringify({
    strong_password_guard: true,
    weak_password_issues: weakIssues.length,
    session_id_claim: true,
    session_ttl_seconds: TOKEN_TTL,
    tampered_token_guard: true,
  }),
);
