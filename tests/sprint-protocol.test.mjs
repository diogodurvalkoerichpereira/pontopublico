/**
 * O5-01 (Onda 5) — protocolo / processo eletrônico: COMPORTAMENTO (ponta a ponta).
 *
 * openProtocolProcess abre com número sequencial por ano; recordProtocolMovement
 * tramita, atualiza a unidade atual e pode concluir. Confere numeração e tramitação.
 *
 * Mutação: não atualizar a unidade atual na tramitação derruba.
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
let unidadeA;
let unidadeB;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "protocol-test-"));

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
  unidadeA = randomUUID();
  unidadeB = randomUUID();
  await db.query(
    "insert into public.unidades (id, tenant_id, codigo, nome, tipo, ativo) values ($1,$2,'A','Protocolo','setor',true),($3,$2,'B','Juridico','setor',true)",
    [unidadeA, tenantId, unidadeB],
  );
  Object.assign(fn, await bundle("src/lib/protocol.functions.ts", "p.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("abre processos com numeração sequencial por ano", async () => {
  const p1 = await fn.openProtocolProcess({
    data: {
      tenant_id: tenantId,
      assunto: "Solicitacao 1",
      interessado: "Fulano",
      unidade_id: unidadeA,
      aberto_em: "2026-02-01",
    },
    context: ctx(),
  });
  const p2 = await fn.openProtocolProcess({
    data: {
      tenant_id: tenantId,
      assunto: "Solicitacao 2",
      interessado: "Beltrano",
      unidade_id: unidadeA,
      aberto_em: "2026-02-02",
    },
    context: ctx(),
  });
  assert.equal(p1.numero, 1);
  assert.equal(p2.numero, 2);
  assert.equal(p1.ano, 2026);
});

test("tramita: atualiza a unidade atual e conclui", async () => {
  const p = await fn.openProtocolProcess({
    data: {
      tenant_id: tenantId,
      assunto: "Tramitar",
      interessado: "Ciclano",
      unidade_id: unidadeA,
      aberto_em: "2026-03-01",
    },
    context: ctx(),
  });
  await fn.recordProtocolMovement({
    data: {
      tenant_id: tenantId,
      process_id: p.id,
      unidade_destino_id: unidadeB,
      despacho: "Encaminho ao juridico",
      concluir: false,
    },
    context: ctx(),
  });
  let row = (
    await db.query(
      "select unidade_atual_id, status from public.protocol_processes where id=$1",
      [p.id],
    )
  ).rows[0];
  assert.equal(row.unidade_atual_id, unidadeB, "unidade atual deve mover");
  assert.equal(row.status, "em_tramitacao");

  await fn.recordProtocolMovement({
    data: {
      tenant_id: tenantId,
      process_id: p.id,
      unidade_destino_id: unidadeB,
      despacho: "Concluido",
      concluir: true,
    },
    context: ctx(),
  });
  row = (
    await db.query("select status from public.protocol_processes where id=$1", [
      p.id,
    ])
  ).rows[0];
  assert.equal(row.status, "concluido");

  // Concluído não tramita mais.
  await assert.rejects(
    fn.recordProtocolMovement({
      data: {
        tenant_id: tenantId,
        process_id: p.id,
        unidade_destino_id: unidadeA,
        despacho: "Reabrir",
        concluir: false,
      },
      context: ctx(),
    }),
    /não está em tramitação/,
  );
});
