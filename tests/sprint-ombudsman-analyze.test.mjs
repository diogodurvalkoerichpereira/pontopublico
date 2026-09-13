/**
 * O5-03c (Onda 5) — tomar manifestação em análise (Lei 13.460): COMPORTAMENTO.
 *
 * analyzeManifestation move uma manifestação RECEBIDA para em_analise, tornando
 * alcançável o status que o ciclo previa mas nada transicionava. Só a recebida
 * entra em análise; em_analise/respondida/arquivada recusam.
 *
 * Mutação: remover a guarda de estado deixa qualquer status entrar em análise —
 * derruba.
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
let seq = 0;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "ombudsman-analyze-test-"));

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

async function seedManifestation(status) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.ombudsman_manifestations
       (id, tenant_id, ano, numero, tipo, canal, descricao, status, prazo_resposta)
     values ($1,$2,2026,$3,'reclamacao','web','Texto',$4,'2026-06-30')`,
    [id, tenantId, seq, status],
  );
  return id;
}

const analyze = (id) =>
  fn.analyzeManifestation({
    data: { tenant_id: tenantId, manifestation_id: id },
    context: ctx(),
  });
const statusOf = async (id) =>
  (
    await db.query(
      "select status from public.ombudsman_manifestations where id=$1",
      [id],
    )
  ).rows[0].status;

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
  Object.assign(fn, await bundle("src/lib/ombudsman.functions.ts", "omb.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("recebida entra em análise; em_analise/respondida/arquivada recusam", async () => {
  const recebida = await seedManifestation("recebida");
  const r = await analyze(recebida);
  assert.equal(r.status, "em_analise");
  assert.equal(await statusOf(recebida), "em_analise");

  // Já em análise: não retorna a esse estado.
  await assert.rejects(analyze(recebida), /recebida/i);

  const respondida = await seedManifestation("respondida");
  await assert.rejects(analyze(respondida), /recebida/i);

  const arquivada = await seedManifestation("arquivada");
  await assert.rejects(analyze(arquivada), /recebida/i);
});
