/**
 * O3-16 (Onda 3) — transição de contrato (Lei 14.133 art. 137-139): COMPORTAMENTO.
 *
 * transitionContract move o contrato pela máquina de estados: vigente ↔ suspenso, e
 * vigente/suspenso → encerrado/rescindido (terminais). Cada ação só vale a partir do
 * estado de origem correto. Confere suspender/retomar, rescindir e a rejeição terminal.
 *
 * Mutação: aceitar ação a partir de estado terminal (ignorar `de`) derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "contract-transition-test-"));

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
  `const PERMS = ["contracts.read","contracts.manage"];
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
async function seedContract(status) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_contracts
       (id, tenant_id, numero, ano, fornecedor, fornecedor_documento, objeto,
        modalidade, valor_total, vigencia_inicio, vigencia_fim, status)
     values ($1,$2,$3,2026,'F','00000000000','Obra','pregao',10000,
        '2026-01-01','2026-12-31',$4)`,
    [id, tenantId, `CT-${seq}`, status],
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
  Object.assign(fn, await bundle("src/lib/contracts.functions.ts", "ct.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const transit = (id, acao) =>
  fn.transitionContract({
    data: { tenant_id: tenantId, contract_id: id, acao },
    context: ctx(),
  });

test("suspende e retoma; rescinde; estado terminal recusa", async () => {
  const c = await seedContract("vigente");

  const r1 = await transit(c, "suspender");
  assert.equal(r1.status, "suspenso");
  const r2 = await transit(c, "retomar");
  assert.equal(r2.status, "vigente");

  const r3 = await transit(c, "rescindir");
  assert.equal(r3.status, "rescindido");

  // Rescindido é terminal: qualquer ação recusa.
  await assert.rejects(transit(c, "suspender"), /não admite/i);
  await assert.rejects(transit(c, "encerrar"), /não admite/i);
});

test("ações exigem o estado de origem correto", async () => {
  // Retomar só de suspenso.
  const vigente = await seedContract("vigente");
  await assert.rejects(transit(vigente, "retomar"), /não admite/i);

  // Encerrar de suspenso funciona.
  const suspenso = await seedContract("suspenso");
  const r = await transit(suspenso, "encerrar");
  assert.equal(r.status, "encerrado");
});
