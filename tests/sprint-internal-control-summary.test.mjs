/**
 * O5-05b (Onda 5 — Controle interno) — painel de acompanhamento: COMPORTAMENTO.
 *
 * getInternalControlSummary consolida a contagem por situação e destaca os VENCIDOS:
 * apontamentos ainda em curso (aberto/em_implementacao) com prazo anterior à data de
 * referência. Um apontamento encerrado (implementado/nao_implementado) nunca é vencido.
 *
 * Mutação: contar apontamento encerrado como vencido (remover o filtro de status no
 * vencidos), ou não filtrar por prazo, derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "internal-control-summary-test-"));

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

let seq = 0;
async function seedFinding({ status, prazo }) {
  seq += 1;
  await db.query(
    `insert into public.internal_control_findings
       (id, tenant_id, ano, numero, area, descricao, recomendacao,
        responsavel, prazo, status)
     values ($1,$2,2026,$3,'Compras','Falha','Corrigir','Fulano',$4,$5)`,
    [randomUUID(), tenantId, seq, prazo, status],
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

test("conta por situação e vencidos só entre os em curso com prazo passado", async () => {
  // Referência: 2026-06-01.
  // Aberto, prazo 2026-05-01 (passado) → VENCIDO.
  await seedFinding({ status: "aberto", prazo: "2026-05-01" });
  // Em implementação, prazo 2026-05-15 (passado) → VENCIDO.
  await seedFinding({ status: "em_implementacao", prazo: "2026-05-15" });
  // Aberto, prazo 2026-07-01 (futuro) → não vencido.
  await seedFinding({ status: "aberto", prazo: "2026-07-01" });
  // Implementado, prazo 2026-04-01 (passado) → encerrado, NÃO vencido.
  await seedFinding({ status: "implementado", prazo: "2026-04-01" });
  // Não implementado, prazo 2026-03-01 (passado) → encerrado, NÃO vencido.
  await seedFinding({ status: "nao_implementado", prazo: "2026-03-01" });

  const r = await fn.getInternalControlSummary({
    data: { tenant_id: tenantId, data_referencia: "2026-06-01" },
    context: ctx(),
  });

  assert.equal(r.total, 5);
  assert.equal(r.porStatus.aberto, 2);
  assert.equal(r.porStatus.em_implementacao, 1);
  assert.equal(r.porStatus.implementado, 1);
  assert.equal(r.porStatus.nao_implementado, 1);
  // Só os dois em curso com prazo passado; encerrados vencidos não contam.
  assert.equal(r.vencidos, 2);
});
