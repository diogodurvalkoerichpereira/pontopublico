/**
 * O1-03a — ponto imutavel e encadeado: teste de COMPORTAMENTO.
 *
 * Sobe o esquema real em PGlite e EXECUTA os handlers reais. Prova a base
 * probatoria: marcacoes com NSR sequencial por ente e encadeamento SHA-256
 * (cada previous_hash = record_hash da anterior), verificacao da cadeia,
 * imutabilidade (o banco recusa UPDATE/DELETE) e deteccao de adulteracao
 * (desabilitando o trigger para simular violacao em nivel de banco).
 *
 * Mutacao: usar sempre o genesis como previous_hash, ou nao recomputar no verify,
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
let otherTenantId;
let linkId;
let userId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "time-clock-test-"));

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
  `export async function loadTenantAccess() { return { permissions: ["people.read","people.manage"] }; }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }`,
);
const auditStub = join(dir, "audit.mjs");
writeFileSync(auditStub, `export async function recordAudit() {}`);

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

async function makeLink(tenant, registration) {
  const personId = randomUUID();
  const id = randomUUID();
  await db.query(
    "insert into public.persons (id, full_name) values ($1,'Servidor')",
    [personId],
  );
  await db.query(
    "insert into public.employment_links (id, tenant_id, person_id, registration_number, status) values ($1,$2,$3,$4,'rascunho')",
    [id, tenant, personId, registration],
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
  otherTenantId = randomUUID();
  await db.query(
    "insert into public.tenants (id, codigo, nome) values ($1,'ENTE2','Entidade 2')",
    [otherTenantId],
  );
  userId = randomUUID();
  await db.query(
    "insert into public.app_users (id, email, password_hash) values ($1,$2,'x')",
    [userId, `a-${userId}@t.local`],
  );
  await db.query("insert into public.profiles (id) values ($1)", [userId]);
  linkId = await makeLink(tenantId, "MAT-1");

  const out = join(dir, "tc.mjs");
  await build({
    entryPoints: ["src/lib/time-clock.functions.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
    external: ["node:*"],
    plugins: [stubPlugin()],
  });
  Object.assign(fn, await import(out));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ userId });

async function punch(tenant, link, when) {
  return fn.recordTimeClockPunch({
    data: { tenant_id: tenant, employment_link_id: link, punch_time: when },
    context: ctx(),
  });
}

test("NSR sequencial e cadeia integra ao gravar marcacoes", async () => {
  const p1 = await punch(tenantId, linkId, "2025-06-01T08:00:00.000Z");
  const p2 = await punch(tenantId, linkId, "2025-06-01T12:00:00.000Z");
  const p3 = await punch(tenantId, linkId, "2025-06-01T13:00:00.000Z");
  assert.deepEqual(
    [p1.nsr, p2.nsr, p3.nsr],
    [1, 2, 3],
    "NSR deve ser sequencial",
  );
  // Cada previous_hash deve ser o record_hash da anterior.
  const rows = (
    await db.query(
      "select nsr, previous_hash, record_hash from public.time_clock_punches where tenant_id=$1 order by nsr",
      [tenantId],
    )
  ).rows;
  assert.equal(rows[0].previous_hash, "0".repeat(64));
  assert.equal(rows[1].previous_hash, rows[0].record_hash);
  assert.equal(rows[2].previous_hash, rows[1].record_hash);

  const check = await fn.verifyTimeClockChain({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  assert.deepEqual(check, { valid: true, count: 3 });
});

test("marcacao e imutavel: UPDATE e DELETE sao recusados", async () => {
  await assert.rejects(
    () =>
      db.query(
        "update public.time_clock_punches set source='app' where tenant_id=$1 and nsr=1",
        [tenantId],
      ),
    /imutavel/i,
  );
  await assert.rejects(
    () =>
      db.query(
        "delete from public.time_clock_punches where tenant_id=$1 and nsr=1",
        [tenantId],
      ),
    /imutavel/i,
  );
});

test("adulteracao em nivel de banco quebra a verificacao", async () => {
  // Desabilita o trigger para simular uma violacao direta no banco (um atacante
  // com acesso ao SGBD), altera um punch_time e reabilita.
  await db.query(
    "alter table public.time_clock_punches disable trigger trg_block_time_clock_mutation",
  );
  await db.query(
    "update public.time_clock_punches set punch_time='2025-06-01T09:30:00.000Z' where tenant_id=$1 and nsr=2",
    [tenantId],
  );
  await db.query(
    "alter table public.time_clock_punches enable trigger trg_block_time_clock_mutation",
  );
  const check = await fn.verifyTimeClockChain({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  assert.equal(check.valid, false);
  assert.equal(check.brokenAtNsr, 2);
});

test("NSR e por ente e o unique recusa duplicado", async () => {
  const link2 = await makeLink(otherTenantId, "MAT-2");
  const p = await punch(otherTenantId, link2, "2025-06-01T08:00:00.000Z");
  assert.equal(p.nsr, 1, "cada ente comeca o NSR em 1");
  // Insercao raw com NSR ja usado no ente e recusada pelo unique.
  await assert.rejects(
    () =>
      db.query(
        `insert into public.time_clock_punches
           (id, tenant_id, employment_link_id, nsr, punch_time, source, previous_hash, record_hash)
         values ($1,$2,$3,1,'2025-06-01T10:00:00Z','manual',$4,$5)`,
        [randomUUID(), otherTenantId, link2, "0".repeat(64), "a".repeat(64)],
      ),
    /unique|duplicate|nsr/i,
  );
});
