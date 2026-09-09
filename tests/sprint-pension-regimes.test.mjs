/**
 * O1-02b — regime previdenciário como entidade: teste de COMPORTAMENTO.
 *
 * Sobe o esquema real em PGlite e EXECUTA os handlers reais (createServerFn/
 * db.server/tenant-access/audit stubados). Prova: o CRUD de `pension_regimes`
 * (RPPS/RGPS) com dedup por código; que `savePersonAndLink` persiste e expõe o
 * `pension_regime_id` do vínculo; e que o trigger recusa um vínculo cujo regime é
 * de outra entidade (coerência de tenant).
 *
 * Mutação: tirar a dedup do CRUD, ou o bloco de coerência do trigger, derruba.
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
let userId;
let savePensionRegime;
let getPensionRegimes;
let savePersonAndLink;
let getPeopleRegistry;

const dir = mkdtempSync(join(tmpdir(), "pension-test-"));

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
  `export async function loadTenantAccess() {
     return { permissions: ["people.read", "people.manage", "people.sensitive.read"] };
   }
   export function requireTenantPermission(a, perm) {
     if (!a.permissions.includes(perm)) throw new Error("Sem permissao: " + perm);
   }
   export async function loadTenantUnitScope() { return { global: true, unitIds: [] }; }
   export function requireUnitInScope() {}`,
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

before(async () => {
  db = await createTestDb();
  globalThis.__db = db;
  tenantId = (
    await db.query(
      "select id from public.tenants order by created_at, id limit 1",
    )
  ).rows[0].id;
  userId =
    (await db.query("select id from public.profiles order by id limit 1"))
      .rows[0]?.id ?? null;
  otherTenantId = randomUUID();
  await db.query(
    "insert into public.tenants (id, codigo, nome) values ($1, 'ENTE2', 'Entidade 2')",
    [otherTenantId],
  );

  ({ savePensionRegime, getPensionRegimes } = await bundle(
    "src/lib/pension-regimes.functions.ts",
    "pension.mjs",
  ));
  ({ savePersonAndLink, getPeopleRegistry } = await bundle(
    "src/lib/people.functions.ts",
    "people.mjs",
  ));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => ({ userId });

test("CRUD de regime: cria RPPS, lista e recusa codigo duplicado", async () => {
  const { id } = await savePensionRegime({
    data: {
      tenant_id: tenantId,
      code: "RPPS_MUN",
      name: "RPPS municipal",
      regime_type: "rpps",
      status: "ativo",
    },
    context: ctx(),
  });
  assert.ok(id);
  const list = await getPensionRegimes({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  const found = list.regimes.find((r) => r.code === "RPPS_MUN");
  assert.ok(found, "regime nao listado");
  assert.equal(found.regime_type, "rpps");
  assert.equal(list.canManage, true);

  await assert.rejects(
    () =>
      savePensionRegime({
        data: {
          tenant_id: tenantId,
          code: "RPPS_MUN",
          name: "Duplicado",
          regime_type: "rpps",
          status: "ativo",
        },
        context: ctx(),
      }),
    /já utilizado/,
  );
});

test("savePersonAndLink persiste e getPeopleRegistry expoe o regime", async () => {
  const { id: regimeId } = await savePensionRegime({
    data: {
      tenant_id: tenantId,
      code: "RGPS",
      name: "RGPS (INSS)",
      regime_type: "rgps",
      status: "ativo",
    },
    context: ctx(),
  });
  await savePersonAndLink({
    data: {
      tenant_id: tenantId,
      person: { full_name: "Servidor Teste" },
      link: {
        registration_number: "MAT-001",
        unit_id: null,
        pension_regime_id: regimeId,
        status: "rascunho",
      },
    },
    context: ctx(),
  });
  const row = (
    await db.query(
      "select pension_regime_id from public.employment_links where registration_number='MAT-001' and tenant_id=$1",
      [tenantId],
    )
  ).rows[0];
  assert.equal(
    row.pension_regime_id,
    regimeId,
    "regime nao persistiu no vinculo",
  );

  const registry = await getPeopleRegistry({
    data: { tenant_id: tenantId, status: "todos" },
    context: ctx(),
  });
  const link = registry.people
    .flatMap((p) => p.links)
    .find((l) => l.registration_number === "MAT-001");
  assert.ok(link, "vinculo nao listado");
  assert.equal(link.pension_regime_id, regimeId);
  assert.equal(link.pension_regime_name, "RGPS (INSS)");
});

test("o trigger recusa vinculo com regime de outra entidade", async () => {
  // Regime da entidade principal; vinculo tentado sob a segunda entidade.
  const { id: regimeId } = await savePensionRegime({
    data: {
      tenant_id: tenantId,
      code: "RPPS_X",
      name: "RPPS X",
      regime_type: "rpps",
      status: "ativo",
    },
    context: ctx(),
  });
  const personId = randomUUID();
  await db.query(
    "insert into public.persons (id, full_name) values ($1, 'Cross Tenant')",
    [personId],
  );
  await assert.rejects(
    () =>
      db.query(
        `insert into public.employment_links
           (id, tenant_id, person_id, registration_number, status, pension_regime_id)
         values ($1, $2, $3, 'X-1', 'rascunho', $4)`,
        [randomUUID(), otherTenantId, personId, regimeId],
      ),
    /regime previdenciario deve pertencer/,
  );
});
