/**
 * O5-05c (Onda 5) — histórico de acompanhamento do controle interno: COMPORTAMENTO.
 *
 * Cada updateInternalControlFinding passa a gravar uma linha em
 * internal_control_followups (status daquele momento + providência), preservando a
 * trilha que a coluna providencia (só a última) perdia;
 * getInternalControlFollowups lista os acompanhamentos em ordem cronológica.
 *
 * Mutação: não gravar o acompanhamento (histórico vazio) derruba.
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

const dir = mkdtempSync(join(tmpdir(), "ic-followups-test-"));

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

async function abre() {
  return fn.openInternalControlFinding({
    data: {
      tenant_id: tenantId,
      area: "Almoxarifado",
      descricao: "Divergencia de estoque",
      recomendacao: "Inventario mensal",
      responsavel: "Chefe",
      aberto_em: "2026-02-01",
      prazo: "2026-06-01",
    },
    context: ctx(),
  });
}

async function acompanha(id, status, providencia, data) {
  return fn.updateInternalControlFinding({
    data: {
      tenant_id: tenantId,
      finding_id: id,
      novo_status: status,
      providencia,
      data_referencia: data,
    },
    context: ctx(),
  });
}

test("cada acompanhamento entra no histórico, em ordem cronológica", async () => {
  const a = await abre();
  await acompanha(
    a.id,
    "em_implementacao",
    "Plano de acao definido",
    "2026-03-01",
  );
  await acompanha(a.id, "implementado", "Inventario concluido", "2026-05-01");

  const r = await fn.getInternalControlFollowups({
    data: { tenant_id: tenantId, finding_id: a.id },
    context: ctx(),
  });
  assert.equal(r.followups.length, 2);
  assert.deepEqual(
    r.followups.map((f) => [f.status, f.providencia, f.data_referencia]),
    [
      ["em_implementacao", "Plano de acao definido", "2026-03-01"],
      ["implementado", "Inventario concluido", "2026-05-01"],
    ],
  );

  // Outro apontamento não vaza para o histórico deste.
  const b = await abre();
  await acompanha(b.id, "em_implementacao", "Outro", "2026-03-10");
  const r2 = await fn.getInternalControlFollowups({
    data: { tenant_id: tenantId, finding_id: a.id },
    context: ctx(),
  });
  assert.equal(r2.followups.length, 2);
});
