/**
 * O3-01b (Onda 3 — Contratos) — resumo dos contratos: COMPORTAMENTO.
 *
 * getContractsSummary consolida a contagem por situação e, dos contratos VIGENTES, o valor
 * contratado, empenhado, executado e o saldo a executar (contratado − executado). Contrato
 * encerrado/rescindido não entra na carteira vigente. Seeda contratos em vários estados e
 * confere os totais.
 *
 * Mutação: computar o saldo como o valor contratado (ignorar o executado), ou incluir os
 * não-vigentes nos totais, derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "contracts-summary-test-"));

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
async function seedContract({ status, total, empenhado = 0, executado = 0 }) {
  seq += 1;
  await db.query(
    `insert into public.procurement_contracts
       (id, tenant_id, numero, ano, fornecedor, fornecedor_documento, objeto,
        modalidade, valor_total, valor_empenhado, valor_executado,
        vigencia_inicio, vigencia_fim, status)
     values ($1,$2,$3,2026,'F','00000000000','Obra','pregao',$4,$5,$6,
        '2026-01-01','2026-12-31',$7)`,
    [randomUUID(), tenantId, `CT-${seq}`, total, empenhado, executado, status],
  );
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

test("resume vigentes: saldo = contratado − executado, ignora não-vigentes", async () => {
  // Vigente A: total 1000, empenhado 800, executado 300 → saldo 700.
  await seedContract({
    status: "vigente",
    total: 1000,
    empenhado: 800,
    executado: 300,
  });
  // Vigente B: total 500, empenhado 500, executado 200 → saldo 300.
  await seedContract({
    status: "vigente",
    total: 500,
    empenhado: 500,
    executado: 200,
  });
  // Encerrado: fora da carteira vigente.
  await seedContract({
    status: "encerrado",
    total: 9000,
    empenhado: 9000,
    executado: 9000,
  });
  // Suspenso: conta em porStatus, fora dos totais vigentes.
  await seedContract({ status: "suspenso", total: 400 });

  const r = await fn.getContractsSummary({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  assert.equal(r.porStatus.vigente, 2);
  assert.equal(r.porStatus.encerrado, 1);
  assert.equal(r.porStatus.suspenso, 1);

  assert.equal(r.valorContratado, 1500);
  assert.equal(r.valorEmpenhado, 1300);
  assert.equal(r.valorExecutado, 500);
  // Saldo a executar = 1500 − 500 = 1000 (só vigentes).
  assert.equal(r.saldoAExecutar, 1000);
});
