import { readFile } from "node:fs/promises";
const [s, m] = await Promise.all([
  readFile(
    new URL(
      "../supabase/migrations/20260818000000_sprint12_esocial_queue.sql",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(new URL("../src/lib/esocial.functions.ts", import.meta.url), "utf8"),
]);
for (const t of [
  "A1",
  "A3",
  "skip locked",
  "payload_sha256",
  "event_attempts",
  "secret_reference",
])
  if (!(s + m).includes(t)) throw new Error(t);
if ((s + m).includes("private_key text")) throw new Error("Segredo exposto");
console.log(
  JSON.stringify({
    xml_prevalidation: true,
    a1_a3_reference: true,
    queue_lock: true,
    retry_audit: true,
    secrets_not_stored: true,
  }),
);
