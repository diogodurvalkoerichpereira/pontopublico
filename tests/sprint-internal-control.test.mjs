/**
 * O5-05 (Onda 5) — controle interno: COMPORTAMENTO.
 *
 * openInternalControlFinding registra o apontamento (número por ano);
 * updateInternalControlFinding acompanha (em_implementacao intermediário;
 * implementado/nao_implementado encerram e gravam a conclusão). Confere a
 * numeração, o encerramento e que um encerrado não transita de novo.
 *
 * Mutação: permitir transitar um apontamento já encerrado derruba.
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

const dir = mkdtempSync(join(tmpdir(), "internal-control-test-"));

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
  `const PERMS = ["analytics.read","analytics.manage"];
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
const abre = (aberto_em = "2026-02-01") =>
  fn.openInternalControlFinding({
    data: {
      tenant_id: tenantId,
      area: "Almoxarifado",
      descricao: "Divergencia de estoque",
      recomendacao: "Realizar inventario mensal",
      responsavel: "Chefe do setor",
      aberto_em,
      prazo: "2026-03-01",
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
  Object.assign(
    fn,
    await bundle("src/lib/internal-control.functions.ts", "ic.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("numeração por ano e acompanhamento até encerrar", async () => {
  const a = await abre();
  const b = await abre();
  assert.equal(a.numero, 1);
  assert.equal(b.numero, 2);

  // em_implementacao é intermediário (não encerra).
  await fn.updateInternalControlFinding({
    data: {
      tenant_id: tenantId,
      finding_id: a.id,
      novo_status: "em_implementacao",
      providencia: "Inventario agendado",
      data_referencia: "2026-02-15",
    },
    context: ctx(),
  });
  let row = (
    await db.query(
      "select status, concluido_em from public.internal_control_findings where id=$1",
      [a.id],
    )
  ).rows[0];
  assert.equal(row.status, "em_implementacao");
  assert.equal(row.concluido_em, null);

  // implementado encerra e grava a conclusão.
  await fn.updateInternalControlFinding({
    data: {
      tenant_id: tenantId,
      finding_id: a.id,
      novo_status: "implementado",
      providencia: "Inventario realizado",
      data_referencia: "2026-02-28",
    },
    context: ctx(),
  });
  row = (
    await db.query(
      "select status, concluido_em::text from public.internal_control_findings where id=$1",
      [a.id],
    )
  ).rows[0];
  assert.equal(row.status, "implementado");
  assert.equal(row.concluido_em, "2026-02-28");

  // Encerrado não transita de novo.
  await assert.rejects(
    fn.updateInternalControlFinding({
      data: {
        tenant_id: tenantId,
        finding_id: a.id,
        novo_status: "nao_implementado",
        providencia: "tentativa de reabrir",
        data_referencia: "2026-03-01",
      },
      context: ctx(),
    }),
    /encerrado/,
  );
});
