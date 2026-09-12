/**
 * O5-03 (Onda 5) — ouvidoria (Lei 13.460): COMPORTAMENTO (ponta a ponta).
 *
 * openManifestation abre com número sequencial por ano e prazo calculado;
 * respondManifestation transiciona recebida→respondida. Confere a numeração
 * sequencial, o prazo de resposta e que uma manifestação já respondida não
 * responde de novo.
 *
 * Mutação: permitir responder uma manifestação já respondida derruba.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { createTestDb } from "./helpers/pglite.mjs";

let db;
let tenantId;
let userId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "ombudsman-test-"));

const dbStub = join(dir, "db.mjs");
writeFileSync(
  dbStub,
  `export async function query(t, p) { const r = await globalThis.__db.query(t, p ?? []); return r.rows; }
   export async function queryOne(t, p) { const r = await globalThis.__db.query(t, p ?? []); return r.rows[0] ?? null; }
   export async function withTransaction(fn) { return fn({ query: async (t, p) => globalThis.__db.query(t, p ?? []) }); }`,
);
const startStub = join(dir, "start.mjs");
writeFileSync(
  startStub,
  `export function createServerFn() {
     let validate = (x) => x;
     const b = { middleware() { return b; }, validator(fn) { validate = fn; return b; },
       inputValidator(fn) { validate = fn; return b; },
       handler(fn) { return async ({ data, context }) => fn({ data: validate(data), context }); } };
     return b;
   }`,
);
const dataStub = join(dir, "data.mjs");
writeFileSync(dataStub, `export const requireAuth = {};`);
const taStub = join(dir, "ta.mjs");
writeFileSync(
  taStub,
  `const PERMS = ["protocol.read","protocol.manage"];
   export async function loadTenantAccess() { return { permissions: PERMS }; }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }`,
);
const auditStub = join(dir, "audit.mjs");
writeFileSync(
  auditStub,
  `export async function recordAudit() {} export async function recordAuditQ() {}`,
);

function stubPlugin() {
  return {
    name: "stub",
    setup(b) {
      const map = [
        [/@tanstack\/react-start$/, startStub],
        [/(^|\/)db\.server$/, dbStub],
        [/(^|\/)data\.functions$/, dataStub],
        [/(^|\/)tenant-access\.server$/, taStub],
        [/(^|\/)audit\.server$/, auditStub],
      ];
      for (const [filter, path] of map)
        b.onResolve({ filter }, () => ({ path, external: true }));
    },
  };
}

async function bundle(entry, name) {
  const out = join(dir, name);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
    external: ["node:*"],
    plugins: [stubPlugin()],
  });
  return import(out);
}

const ctx = () => ({ userId });
const open = (tipo, aberta_em = "2026-02-01") =>
  fn.openManifestation({
    data: {
      tenant_id: tenantId,
      tipo,
      canal: "web",
      anonima: false,
      descricao: "Buraco na via publica ha meses",
      aberta_em,
      prazo_dias: 30,
    },
    context: ctx(),
  });

before(async () => {
  db = await createTestDb();
  globalThis.__db = db;
  tenantId = (
    await db.query(
      "select id from public.tenants order by created_at, id limit 1",
    )
  ).rows[0].id;
  userId = randomUUID();
  await db.query(
    "insert into public.app_users (id, email, password_hash) values ($1,$2,'x')",
    [userId, `a-${userId}@t.local`],
  );
  await db.query("insert into public.profiles (id) values ($1)", [userId]);
  Object.assign(fn, await bundle("src/lib/ombudsman.functions.ts", "o.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("abre com numero sequencial por ano e prazo calculado", async () => {
  const a = await open("reclamacao");
  const b = await open("denuncia");
  assert.equal(a.ano, 2026);
  assert.equal(a.numero, 1);
  assert.equal(b.numero, 2);
  // 2026-02-01 + 30 dias = 2026-03-03
  assert.equal(a.prazo_resposta, "2026-03-03");

  // Ano diferente reinicia a numeração.
  const c = await open("sugestao", "2027-01-10");
  assert.equal(c.ano, 2027);
  assert.equal(c.numero, 1);
});

test("responde e nao responde de novo", async () => {
  const m = await open("informacao");
  const r = await fn.respondManifestation({
    data: {
      tenant_id: tenantId,
      manifestation_id: m.id,
      resposta: "Servico agendado para a proxima semana",
      respondida_em: "2026-02-10",
    },
    context: ctx(),
  });
  assert.equal(r.status, "respondida");
  const row = (
    await db.query(
      "select status, respondida_em::text from public.ombudsman_manifestations where id=$1",
      [m.id],
    )
  ).rows[0];
  assert.equal(row.status, "respondida");
  assert.equal(row.respondida_em, "2026-02-10");

  await assert.rejects(
    fn.respondManifestation({
      data: {
        tenant_id: tenantId,
        manifestation_id: m.id,
        resposta: "Outra resposta",
        respondida_em: "2026-02-11",
      },
      context: ctx(),
    }),
    /aberto/,
  );
});
