/**
 * O5-09 (Onda 5) — Carta de Serviços ao Cidadão (Lei 13.460 art. 7º): COMPORTAMENTO.
 *
 * publishCitizenService só publica um serviço COMPLETO (descrição, prazo > 0 e canais);
 * despublicar é sempre permitido; nomes são únicos por ente. Confere a guarda de
 * completude, a despublicação e a unicidade de nome.
 *
 * Mutação: ignorar a completude ao publicar derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "citizen-services-test-"));

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

const save = (over = {}) =>
  fn.saveCitizenService({
    data: {
      tenant_id: tenantId,
      nome: "Emissao de certidao",
      descricao: "Emite certidao negativa",
      prazo_dias: 5,
      canais: "web, presencial",
      taxa: 0,
      ...over,
    },
    context: ctx(),
  });

const publish = (id, publicar) =>
  fn.publishCitizenService({
    data: { tenant_id: tenantId, service_id: id, publicar },
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
  Object.assign(
    fn,
    await bundle("src/lib/citizen-services.functions.ts", "cs.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("serviço completo publica; incompleto não; nome é único", async () => {
  const { id } = await save();
  const r = await publish(id, true);
  assert.equal(r.publicado, true);

  // Despublicar é sempre permitido.
  const r2 = await publish(id, false);
  assert.equal(r2.publicado, false);

  // Serviço sem canais e sem prazo: incompleto, não publica.
  const inc = await save({
    nome: "Servico incompleto",
    prazo_dias: 0,
    canais: null,
  });
  await assert.rejects(publish(inc.id, true), /incompleto/i);

  // Nome duplicado é recusado.
  await assert.rejects(
    save({ nome: "servico incompleto" }),
    /já existe serviço/i,
  );
});
