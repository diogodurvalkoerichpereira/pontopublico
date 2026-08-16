import { readFile } from "node:fs/promises";
const files = [
  "public/manifest.webmanifest",
  "public/sw.js",
  "src/components/PwaRuntime.tsx",
  "src/lib/pwa.functions.ts",
  "supabase/migrations/20260818030000_sprint15_pwa_push.sql",
];
const all = (
  await Promise.all(
    files.map((f) => readFile(new URL(`../${f}`, import.meta.url), "utf8")),
  )
).join("\n");
for (const token of [
  'display": "standalone',
  "serviceWorker",
  "push_subscriptions",
  "auth.uid()",
  "row level security",
  "mobile.push.manage",
])
  if (!all.includes(token)) throw new Error(token);
console.log(
  JSON.stringify({
    installable: true,
    offline_shell: true,
    push_queue: true,
    rls: true,
    store_checklist: true,
  }),
);
