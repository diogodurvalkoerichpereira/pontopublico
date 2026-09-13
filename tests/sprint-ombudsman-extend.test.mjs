/**
 * O5-03d (Onda 5) — prorrogação do prazo de resposta da ouvidoria (Lei 13.460
 * art. 17): COMPORTAMENTO.
 *
 * extendManifestationDeadline soma o período ao prazo vigente, marca
 * `prazo_prorrogado` e grava a justificativa. O prazo é prorrogável de forma
 * justificada UMA ÚNICA VEZ: a segunda prorrogação é recusada. Só uma
 * manifestação em aberto (recebida/em_analise) prorroga; respondida/arquivada
 * recusam.
 *
 * Mutação: não marcar `prazo_prorrogado=true` deixa prorrogar de novo — derruba.
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

const dir = mkdtempSync(join(tmpdir(), "ombudsman-extend-test-"));

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

async function seedManifestation(status, prazo = "2026-06-30") {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.ombudsman_manifestations
       (id, tenant_id, ano, numero, tipo, canal, descricao, status, prazo_resposta)
     values ($1,$2,2026,$3,'reclamacao','web','Texto',$4,$5::date)`,
    [id, tenantId, seq, status, prazo],
  );
  return id;
}

const extend = (id, prazo_dias) =>
  fn.extendManifestationDeadline({
    data: {
      tenant_id: tenantId,
      manifestation_id: id,
      justificativa: "Necessario diligencia adicional (art. 17)",
      ...(prazo_dias === undefined ? {} : { prazo_dias }),
    },
    context: ctx(),
  });
const rowOf = async (id) =>
  (
    await db.query(
      `select prazo_resposta::text as prazo, prazo_prorrogado,
              prorrogacao_justificativa as justificativa
       from public.ombudsman_manifestations where id=$1`,
      [id],
    )
  ).rows[0];

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

test("prorroga o prazo uma vez; segunda recusa; só em aberto", async () => {
  const recebida = await seedManifestation("recebida", "2026-06-30");
  const r = await extend(recebida, 30);
  assert.equal(r.prazo_prorrogado, true);
  assert.equal(r.prazo_resposta, "2026-07-30"); // +30 dias sobre 2026-06-30
  const row = await rowOf(recebida);
  assert.equal(row.prazo, "2026-07-30");
  assert.equal(row.prazo_prorrogado, true);
  assert.match(row.justificativa, /diligencia/i);

  // Prorrogação é única: a segunda é recusada.
  await assert.rejects(extend(recebida, 30), /já foi prorrogado/i);

  // Em análise também pode prorrogar (default 30 dias).
  const emAnalise = await seedManifestation("em_analise", "2026-05-31");
  const r2 = await extend(emAnalise);
  assert.equal(r2.prazo_resposta, "2026-06-30"); // maio tem 31 dias

  // Respondida/arquivada não prorrogam.
  const respondida = await seedManifestation("respondida");
  await assert.rejects(extend(respondida, 30), /em aberto/i);
  const arquivada = await seedManifestation("arquivada");
  await assert.rejects(extend(arquivada, 30), /em aberto/i);
});
