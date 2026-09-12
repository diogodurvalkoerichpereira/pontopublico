/**
 * O3-01c (Onda 3 — Contratos) — contratos a vencer: COMPORTAMENTO.
 *
 * getExpiringContracts lista os contratos VIGENTES cuja vigência final cai entre a data de
 * referência e `dias` à frente (inclusive). Contrato fora da janela, ou já vencido, ou
 * não-vigente, não entra.
 *
 * Mutação: incluir contratos não vigentes (remover o filtro status='vigente') derruba o
 * teste.
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

const dir = mkdtempSync(join(tmpdir(), "contracts-expiring-test-"));

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
async function seedContract({ status, vigencia_fim }) {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.procurement_contracts
       (id, tenant_id, numero, ano, fornecedor, fornecedor_documento, objeto,
        modalidade, valor_total, vigencia_inicio, vigencia_fim, status)
     values ($1,$2,$3,2026,'F','00000000000','Obra','pregao',10000,
        '2026-01-01',$4,$5)`,
    [id, tenantId, `CT-${seq}`, vigencia_fim, status],
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

test("lista vigentes a vencer na janela; ignora fora da janela e não-vigentes", async () => {
  // Referência 2026-06-01, janela 30 dias (até 2026-07-01).
  const dentro = await seedContract({
    status: "vigente",
    vigencia_fim: "2026-06-20",
  }); // dentro
  await seedContract({ status: "vigente", vigencia_fim: "2026-08-01" }); // além da janela
  await seedContract({ status: "vigente", vigencia_fim: "2026-05-20" }); // já vencido
  // Encerrado dentro da janela: não alerta.
  await seedContract({ status: "encerrado", vigencia_fim: "2026-06-15" });

  const r = await fn.getExpiringContracts({
    data: { tenant_id: tenantId, data_referencia: "2026-06-01", dias: 30 },
    context: ctx(),
  });

  assert.equal(r.contracts.length, 1);
  assert.equal(r.contracts[0].id, dentro);
  assert.equal(r.contracts[0].dias_para_vencer, 19); // 2026-06-20 − 2026-06-01
});
