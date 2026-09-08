/**
 * Sprint 19 — suporte contextual e chat: teste de COMPORTAMENTO
 * (substitui o grep validate-sprint19.mjs).
 *
 * Duas redes. (1) COMPORTAMENTO no banco: sobe o esquema real em PGlite e provoca
 * o CHECK de `support_messages.body` (1..4000 chars), o CHECK de status de
 * `support_conversations` e a unicidade `(tenant_id,slug)` de `support_articles`
 * (provada num ente real: com tenant_id nulo o Postgres trata NULLs como
 * distintos). (2) CATÁLOGO: a policy `support_message_participant`
 * existe. Rede de conformidade (lint): o módulo exporta as funções de suporte e o
 * componente do widget existe.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "./helpers/pglite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let db;
let tenantId;
let conversationId;

const USER = "19000000-0000-4000-8000-000000000019";

before(async () => {
  db = await createTestDb();
  tenantId = (
    await db.query(
      "select id from public.tenants where status='ativo' order by created_at,id limit 1",
    )
  ).rows[0].id;
  // Identidade própria: app_users → profiles (user_id/sender_id apontam para profiles).
  await db.query(
    "insert into public.app_users(id,email,password_hash) values($1,'u19@e.com','x')",
    [USER],
  );
  await db.query("insert into public.profiles(id,full_name) values($1,'U19')", [
    USER,
  ]);
  conversationId = (
    await db.query(
      `insert into public.support_conversations(tenant_id,user_id,subject) values($1,$2,'Dúvida') returning id`,
      [tenantId, USER],
    )
  ).rows[0].id;
});

after(async () => {
  await db.close();
});

test("as tabelas de suporte existem", async () => {
  const r = await db.query(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name = any($1)`,
    [["support_articles", "support_conversations", "support_messages"]],
  );
  assert.equal(r.rows.length, 3);
});

test("CHECK: corpo de mensagem não pode ser vazio", async () => {
  await assert.rejects(
    db.query(
      `insert into public.support_messages(conversation_id,sender_id,body) values($1,$2,'')`,
      [conversationId, USER],
    ),
    /body|char_length|check/i,
  );
});

test("uma mensagem válida é aceita", async () => {
  await db.query(
    `insert into public.support_messages(conversation_id,sender_id,body) values($1,$2,'Olá')`,
    [conversationId, USER],
  );
  const r = await db.query(
    "select 1 from public.support_messages where conversation_id=$1",
    [conversationId],
  );
  assert.equal(r.rows.length, 1);
});

test("CHECK: status de conversa restrito a open/waiting/resolved ('closed' recusado)", async () => {
  await assert.rejects(
    db.query(
      `insert into public.support_conversations(tenant_id,user_id,subject,status) values($1,$2,'X','closed')`,
      [tenantId, USER],
    ),
    /status|check/i,
  );
});

test("UNIQUE: (tenant_id,slug) não se repete no mesmo ente", async () => {
  // A unicidade é (tenant_id,slug). Com tenant_id nulo o Postgres trata NULLs como
  // distintos (NULLS DISTINCT), então a duplicidade só se prova num ente real.
  const article = () =>
    db.query(
      `insert into public.support_articles(tenant_id,slug,title,content)
       values($1,'guia-local','Guia','conteudo')`,
      [tenantId],
    );
  await article();
  await assert.rejects(article(), /unique|duplicate/i);
});

test("catálogo: a policy support_message_participant existe", async () => {
  const r = await db.query(
    `select 1 from pg_policies
     where tablename='support_messages' and policyname='support_message_participant'`,
  );
  assert.equal(r.rows.length, 1);
});

test("lint: o módulo exporta as funções de suporte e o widget existe", () => {
  const mod = readFileSync(
    join(root, "src", "lib", "support.functions.ts"),
    "utf8",
  );
  assert.match(mod, /export const findContextualHelp/);
  assert.match(mod, /export const openSupportConversation/);
  const widget = readFileSync(
    join(root, "src", "components", "SupportWidget.tsx"),
    "utf8",
  );
  assert.match(widget, /SupportWidget/);
});
