// Sprint 12 — fila do eSocial.
//
// A assinatura e a transmissão não estão implementadas. Até a Sprint 20 a fila
// marcava eventos como `assinado` sem executar operação criptográfica alguma.
// Este validador impede que esse estado de sucesso falso volte ao código.
import { readFile } from "node:fs/promises";

const [sql, ts] = await Promise.all([
  readFile(
    new URL(
      "../supabase/migrations/20260818000000_sprint12_esocial_queue.sql",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(new URL("../src/lib/esocial.functions.ts", import.meta.url), "utf8"),
]);

// Guarda de honestidade: nada pode marcar evento como assinado sem assinar.
if (/status\s*=\s*'assinado'/.test(ts))
  throw new Error(
    "Evento marcado como 'assinado' sem assinatura: não há assinador XMLDSig no projeto.",
  );
if (!ts.includes("NotImplementedConformanceError"))
  throw new Error(
    "processEsocialQueue deve falhar explicitamente enquanto a integração não existir.",
  );

// Segredo de certificado nunca no banco.
if ((sql + ts).includes("private_key text")) throw new Error("Segredo exposto");

// Estrutura da fila que deve permanecer no esquema.
// Nota: a consulta com `for update skip locked` saiu do código junto com o
// laço que fingia assinar. Ela volta quando houver um assinador de verdade.
for (const t of [
  "A1",
  "A3",
  "payload_sha256",
  "esocial_event_attempts",
  "secret_reference",
])
  if (!(sql + ts).includes(t)) throw new Error(t);

console.log(
  JSON.stringify({
    assinatura_implementada: false,
    falha_explicita: true,
    a1_a3_reference: true,
    secrets_not_stored: true,
  }),
);
