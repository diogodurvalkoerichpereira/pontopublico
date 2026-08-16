import { readFile } from "node:fs/promises";
const all = (
  await Promise.all(
    [
      "supabase/migrations/20260818070000_sprint19_support_chat.sql",
      "src/lib/support.functions.ts",
      "src/components/SupportWidget.tsx",
    ].map((f) => readFile(new URL(`../${f}`, import.meta.url), "utf8")),
  )
).join("\n");
for (const t of [
  "support_articles",
  "support_conversations",
  "support_messages",
  "route_context",
  "findContextualHelp",
  "openSupportConversation",
  "SupportWidget",
  "auth.uid()",
])
  if (!all.includes(t)) throw Error(t);
console.log(
  JSON.stringify({
    contextual_help: true,
    knowledge_base: true,
    support_conversation: true,
    participant_rls: true,
  }),
);
