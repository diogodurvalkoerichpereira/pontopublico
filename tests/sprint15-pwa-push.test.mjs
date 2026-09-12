/**
 * Sprint 15 — PWA e notificações push: teste de COMPORTAMENTO
 * (substitui o grep validate-sprint15.mjs).
 *
 * Três redes. (1) COMPORTAMENTO no banco: sobe o esquema real em PGlite e provoca
 * os CHECKs de `push_notifications` (title com 1..120 chars; status na whitelist)
 * e a unicidade `(user_id,endpoint)` de `push_subscriptions`. (2) CATÁLOGO: a
 * permissão `mobile.push.manage` existe. (3) CONFORMIDADE (lint): o manifest é
 * standalone e o service worker registra listener de push.
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

const USER = "15000000-0000-4000-8000-000000000015";

before(async () => {
  db = await createTestDb();
  const t = await db.query(
    "select id from public.tenants where status='ativo' order by created_at,id limit 1",
  );
  tenantId = t.rows[0].id;
  // Identidade própria: app_users → profiles (created_by/user_id apontam para profiles).
  await db.query(
    "insert into public.app_users(id,email,password_hash) values($1,'u15@e.com','x')",
    [USER],
  );
  await db.query("insert into public.profiles(id,full_name) values($1,'U15')", [
    USER,
  ]);
});

after(async () => {
  await db.close();
});

test("as tabelas de push existem", async () => {
  const r = await db.query(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name = any($1)`,
    [["push_subscriptions", "push_notifications"]],
  );
  assert.equal(r.rows.length, 2);
});

test("CHECK: título de notificação não pode ser vazio", async () => {
  await assert.rejects(
    db.query(
      `insert into public.push_notifications(tenant_id,title,body,created_by)
       values($1,'','corpo',$2)`,
      [tenantId, USER],
    ),
    /title|char_length|check/i,
  );
});

test("CHECK: status de notificação restrito à whitelist", async () => {
  await assert.rejects(
    db.query(
      `insert into public.push_notifications(tenant_id,title,body,status,created_by)
       values($1,'Oi','corpo','estado_invalido',$2)`,
      [tenantId, USER],
    ),
    /status|check/i,
  );
});

test("UNIQUE: (user_id,endpoint) não se repete em push_subscriptions", async () => {
  const sub = () =>
    db.query(
      `insert into public.push_subscriptions(tenant_id,user_id,endpoint,p256dh,auth_secret)
       values($1,$2,'https://push.example/abc','k','s')`,
      [tenantId, USER],
    );
  await sub();
  await assert.rejects(sub(), /unique|duplicate/i);
});

test("catálogo: a permissão mobile.push.manage existe", async () => {
  const r = await db.query(
    "select 1 from public.security_permissions where codigo='mobile.push.manage'",
  );
  assert.equal(r.rows.length, 1);
});

test("lint: manifest standalone e service worker com listener de push", () => {
  const manifest = JSON.parse(
    readFileSync(join(root, "public", "manifest.webmanifest"), "utf8"),
  );
  assert.equal(manifest.display, "standalone");
  const sw = readFileSync(join(root, "public", "sw.js"), "utf8");
  assert.match(sw, /addEventListener\("push"/);
  const runtime = readFileSync(
    join(root, "src", "components", "PwaRuntime.tsx"),
    "utf8",
  );
  assert.match(runtime, /serviceWorker/);
});
