/**
 * O5-04 (Onda 5) — e-SIC / acesso à informação (LAI): COMPORTAMENTO.
 *
 * openEsicRequest abre com número por ano e prazo de 20 dias; extendEsicRequest
 * prorroga por mais 10 (uma só vez); respondEsicRequest fecha (respondido/
 * indeferido). Confere o prazo, a prorrogação única e que só pedido em aberto
 * responde.
 *
 * Mutação: permitir prorrogar duas vezes derruba.
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

const dir = mkdtempSync(join(tmpdir(), "esic-test-"));

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
const open = (aberto_em = "2026-02-01") =>
  fn.openEsicRequest({
    data: {
      tenant_id: tenantId,
      solicitante: "Cidadao",
      anonimo: false,
      pedido: "Copia dos contratos vigentes",
      aberto_em,
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
  Object.assign(fn, await bundle("src/lib/esic.functions.ts", "e.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("abre com prazo de 20 dias, prorroga +10 uma vez só", async () => {
  const a = await open();
  assert.equal(a.numero, 1);
  // 2026-02-01 + 20 = 2026-02-21
  assert.equal(a.prazo_resposta, "2026-02-21");

  const ext = await fn.extendEsicRequest({
    data: { tenant_id: tenantId, request_id: a.id },
    context: ctx(),
  });
  // +10 => 2026-03-03
  assert.equal(ext.prazo_resposta, "2026-03-03");

  // Segunda prorrogação é recusada.
  await assert.rejects(
    fn.extendEsicRequest({
      data: { tenant_id: tenantId, request_id: a.id },
      context: ctx(),
    }),
    /prorrogado uma vez/,
  );
});

test("responde pedido em aberto e não responde de novo", async () => {
  const a = await open();
  const r = await fn.respondEsicRequest({
    data: {
      tenant_id: tenantId,
      request_id: a.id,
      desfecho: "respondido",
      resposta: "Segue em anexo",
      respondido_em: "2026-02-10",
    },
    context: ctx(),
  });
  assert.equal(r.status, "respondido");

  await assert.rejects(
    fn.respondEsicRequest({
      data: {
        tenant_id: tenantId,
        request_id: a.id,
        desfecho: "indeferido",
        resposta: "Outra",
        respondido_em: "2026-02-11",
      },
      context: ctx(),
    }),
    /em aberto/,
  );
  // Pedido já respondido não prorroga.
  await assert.rejects(
    fn.extendEsicRequest({
      data: { tenant_id: tenantId, request_id: a.id },
      context: ctx(),
    }),
    /recebido/,
  );
});
