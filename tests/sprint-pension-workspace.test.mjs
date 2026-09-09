/**
 * O1-02d — workspace da UI de previdencia: teste de COMPORTAMENTO.
 *
 * getPensionWorkspace reune numa chamada os regimes do ente, o catalogo de
 * rubricas ATIVAS (para o multi-select) e o mapa regime -> rubricas. Confere:
 *  - regimes do ente ordenados por codigo;
 *  - so rubricas ativas entram no catalogo (a inativa fica de fora);
 *  - o mapa regime->rubricas reflete o vinculo gravado.
 *
 * Mutacao: tirar o filtro status='ativo' das rubricas (a inativa vaza) derruba.
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
let regimeRpps;
let rubricA;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "pension-ws-test-"));

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
  `const PERMS = ["people.read","people.manage","payroll.assignments.manage"];
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

async function seedRubric(code, status) {
  const id = randomUUID();
  await db.query(
    `insert into public.payroll_rubrics
       (id, tenant_id, code, name, nature, unit, calculation_order, status, created_by)
     values ($1,$2,$3,$3,'desconto','valor',50,$4,$5)`,
    [id, tenantId, code, status, userId],
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

  regimeRpps = randomUUID();
  await db.query(
    `insert into public.pension_regimes (id,tenant_id,code,name,regime_type,status,created_by)
     values ($1,$2,'RPPS','Regime Proprio','rpps','ativo',$3)`,
    [regimeRpps, tenantId, userId],
  );
  await db.query(
    `insert into public.pension_regimes (id,tenant_id,code,name,regime_type,status,created_by)
     values ($1,$2,'RGPS','Regime Geral','rgps','ativo',$3)`,
    [randomUUID(), tenantId, userId],
  );

  rubricA = await seedRubric("RPPS_SEG", "ativo");
  const rubricB = await seedRubric("RPPS_PAT", "ativo");
  await seedRubric("VELHA", "inativo"); // nao pode aparecer no catalogo

  for (const rid of [rubricA, rubricB]) {
    await db.query(
      `insert into public.pension_regime_rubrics (tenant_id,pension_regime_id,rubric_id,created_by)
       values ($1,$2,$3,$4)`,
      [tenantId, regimeRpps, rid, userId],
    );
  }

  Object.assign(
    fn,
    await bundle("src/lib/pension-regimes.functions.ts", "pen.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("o workspace reune regimes, catalogo ativo e o mapa regime->rubricas", async () => {
  const ws = await fn.getPensionWorkspace({
    data: { tenant_id: tenantId },
    context: { userId },
  });
  // Regimes do ente, ordenados por codigo (RGPS antes de RPPS).
  assert.equal(ws.regimes.length, 2);
  assert.deepEqual(
    ws.regimes.map((r) => r.code),
    ["RGPS", "RPPS"],
  );
  // Catalogo: so rubricas ativas (a "VELHA" inativa fica de fora).
  assert.equal(ws.rubrics.length, 2);
  assert.ok(!ws.rubrics.some((r) => r.code === "VELHA"), "inativa vazou");
  // Mapa: as duas rubricas do RPPS.
  const doRpps = ws.regimeRubrics.filter(
    (m) => m.pension_regime_id === regimeRpps,
  );
  assert.equal(doRpps.length, 2);
  assert.ok(doRpps.some((m) => m.rubric_id === rubricA));
  // Flags de gestao.
  assert.equal(ws.canManageRegimes, true);
  assert.equal(ws.canManageRubrics, true);
});
