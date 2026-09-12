/**
 * O5-01c (Onda 5 — Protocolo) — arquivamento do processo: COMPORTAMENTO.
 *
 * archiveProtocolProcess move um processo CONCLUÍDO para arquivado; em tramitação não
 * arquiva (precisa concluir antes) e arquivado é terminal. Confere a transição e as
 * recusas.
 *
 * Mutação: permitir arquivar um processo em tramitação (ignorar o estado de origem)
 * derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "protocol-archive-test-"));

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

let seq = 0;
async function seedProcess(status) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.protocol_processes
       (id, tenant_id, ano, numero, assunto, interessado, status, aberto_em)
     values ($1,$2,2026,$3,'Assunto','Fulano',$4,'2026-01-01')`,
    [id, tenantId, seq, status],
  );
  return id;
}

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
  Object.assign(fn, await bundle("src/lib/protocol.functions.ts", "proto.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const archive = (id) =>
  fn.archiveProtocolProcess({
    data: { tenant_id: tenantId, process_id: id, motivo: "Fim do tramite" },
    context: ctx(),
  });
const statusOf = async (id) =>
  (
    await db.query("select status from public.protocol_processes where id=$1", [
      id,
    ])
  ).rows[0].status;

test("arquiva um concluído; recusa em tramitação e re-arquivamento", async () => {
  const concluido = await seedProcess("concluido");
  const r = await archive(concluido);
  assert.equal(r.status, "arquivado");
  assert.equal(await statusOf(concluido), "arquivado");

  // Em tramitação não arquiva.
  const tramitando = await seedProcess("em_tramitacao");
  await assert.rejects(archive(tramitando), /concluído/i);

  // Já arquivado é terminal.
  await assert.rejects(archive(concluido), /concluído/i);
});
