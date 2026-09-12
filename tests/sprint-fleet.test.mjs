/**
 * O3-05 (Onda 3) — frotas: COMPORTAMENTO (ponta a ponta).
 *
 * recordFleetEvent registra abastecimento/manutenção e avança o hodômetro, que
 * nunca retrocede. Confere o avanço e a recusa de retrocesso.
 *
 * Mutação: remover a checagem de retrocesso do hodômetro derruba.
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
let vehicleId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "fleet-test-"));

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
  `const PERMS = ["assets.read","assets.manage"];
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
  Object.assign(fn, await bundle("src/lib/fleet.functions.ts", "f.mjs"));
  vehicleId = (
    await fn.saveFleetVehicle({
      data: {
        tenant_id: tenantId,
        placa: "ABC1D23",
        modelo: "Gol",
        ano: 2020,
        status: "ativo",
      },
      context: ctx(),
    })
  ).id;
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

const event = (odometro, litros) =>
  fn.recordFleetEvent({
    data: {
      tenant_id: tenantId,
      vehicle_id: vehicleId,
      tipo: "abastecimento",
      data_evento: "2026-03-10",
      odometro,
      litros,
      valor: 300,
      historico: "Abastecimento",
    },
    context: ctx(),
  });

test("o hodômetro avança com o evento", async () => {
  const r = await event(10000, 40);
  assert.equal(r.odometro_atual, 10000);
  const r2 = await event(10500, 42);
  assert.equal(r2.odometro_atual, 10500);
  const veh = await fn.getFleetVehicles({
    data: { tenant_id: tenantId },
    context: ctx(),
  });
  assert.equal(Number(veh.vehicles[0].odometro_atual), 10500);
});

test("hodômetro não pode retroceder", async () => {
  await assert.rejects(event(9000, 30), /não pode retroceder/);
});
