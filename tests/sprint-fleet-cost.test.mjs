/**
 * O3-05c (Onda 3) — custo total da frota por veículo no período: COMPORTAMENTO.
 *
 * getFleetCostSummary consolida, por veículo, o gasto com abastecimento e com
 * manutenção no intervalo, com o total por veículo e os totais do ente. Evento fora
 * do período não entra; veículo sem evento fica zerado (mas listado).
 *
 * Mutação: trocar o tipo somado (combustível ↔ manutenção) ou ignorar o filtro de
 * período derruba.
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

const dir = mkdtempSync(join(tmpdir(), "fleet-cost-test-"));

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

let placaSeq = 0;
async function seedVehicle() {
  placaSeq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.fleet_vehicles (id, tenant_id, placa, modelo, ano, status)
     values ($1,$2,$3,'Modelo',2020,'ativo')`,
    [id, tenantId, `ABC${1000 + placaSeq}`],
  );
  return id;
}

async function seedEvent(vehicleId, tipo, valor, data) {
  await db.query(
    `insert into public.fleet_events
       (id, tenant_id, vehicle_id, tipo, data_evento, odometro, litros, valor, historico)
     values ($1,$2,$3,$4,$5,1000,null,$6,'evento')`,
    [randomUUID(), tenantId, vehicleId, tipo, data, valor],
  );
}

let v1, v2;
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
  Object.assign(fn, await bundle("src/lib/fleet.functions.ts", "fl.mjs"));

  v1 = await seedVehicle(); // ABC1001
  v2 = await seedVehicle(); // ABC1002
  // V1 no período março: combustível 200+300, manutenção 800.
  await seedEvent(v1, "abastecimento", 200, "2026-03-05");
  await seedEvent(v1, "abastecimento", 300, "2026-03-20");
  await seedEvent(v1, "manutencao", 800, "2026-03-15");
  // V1 fora do período (maio, após o intervalo): não entra (guarda o limite superior).
  await seedEvent(v1, "abastecimento", 999, "2026-05-01");
  // V2 no período: combustível 100.
  await seedEvent(v2, "abastecimento", 100, "2026-03-10");
  // V2 fora do período (fevereiro, antes do intervalo): não entra (guarda o limite inferior).
  await seedEvent(v2, "abastecimento", 50, "2026-02-20");
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("custo da frota por veículo no período, com totais do ente", async () => {
  const r = await fn.getFleetCostSummary({
    data: { tenant_id: tenantId, from: "2026-03-01", to: "2026-03-31" },
    context: ctx(),
  });

  assert.equal(r.veiculos.length, 2);
  // Ordena por placa: ABC1001 primeiro.
  assert.equal(r.veiculos[0].id, v1);

  const a = r.veiculos.find((x) => x.id === v1);
  assert.equal(a.combustivel, 500); // 200+300 (o de maio ficou fora)
  assert.equal(a.manutencao, 800);
  assert.equal(a.total, 1300);

  const b = r.veiculos.find((x) => x.id === v2);
  assert.equal(b.combustivel, 100);
  assert.equal(b.manutencao, 0);
  assert.equal(b.total, 100);

  // Totais do ente.
  assert.equal(r.totais.combustivel, 600); // 500 + 100
  assert.equal(r.totais.manutencao, 800);
  assert.equal(r.totais.total, 1400);
});
