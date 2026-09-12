/**
 * O3-05b (Onda 3) — Consumo e custo por veículo da frota: COMPORTAMENTO.
 *
 * getFleetConsumption calcula o consumo médio (km/l) pelo método de tanque a tanque: os
 * litros do PRIMEIRO abastecimento não entram (encheram o tanque no odômetro inicial);
 * só os seguintes são atribuídos à distância entre o primeiro e o último abastecimento.
 * O custo por km usa o gasto com combustível já consumido (também exclui o primeiro).
 *
 * Mutação: não excluir o primeiro abastecimento (dividir por todos os litros) muda o
 * consumo e derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "fleet-consumption-test-"));

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

async function seedEvent(
  vehicleId,
  tipo,
  odometro,
  litros,
  valor,
  data = "2026-03-01",
) {
  await db.query(
    `insert into public.fleet_events
       (id, tenant_id, vehicle_id, tipo, data_evento, odometro, litros, valor, historico)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'evento')`,
    [randomUUID(), tenantId, vehicleId, tipo, data, odometro, litros, valor],
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
  Object.assign(fn, await bundle("src/lib/fleet.functions.ts", "fl.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("consumo de tanque a tanque exclui o primeiro abastecimento", async () => {
  const v = await seedVehicle();
  // 1º abastecimento (odô 1000, 50 L, R$300) — enche o tanque, não conta no consumo.
  await seedEvent(v, "abastecimento", 1000, 50, 300, "2026-03-01");
  // 2º (odô 1400, 40 L, R$240) e 3º (odô 1900, 50 L, R$300).
  await seedEvent(v, "abastecimento", 1400, 40, 240, "2026-03-10");
  await seedEvent(v, "abastecimento", 1900, 50, 300, "2026-03-20");
  // Manutenção (não afeta o consumo).
  await seedEvent(v, "manutencao", 1500, null, 800, "2026-03-15");

  const r = await fn.getFleetConsumption({
    data: { tenant_id: tenantId, vehicle_id: v },
    context: ctx(),
  });

  assert.equal(r.abastecimentos, 3);
  assert.equal(r.litrosAbastecidos, 140);
  assert.equal(r.gastoCombustivel, 840);
  assert.equal(r.gastoManutencao, 800);
  // km = 1900 - 1000 = 900; litros consumidos = 140 - 50 (primeiro) = 90.
  assert.equal(r.kmPercorridos, 900);
  assert.equal(r.consumoMedio, 10); // 900 / 90
  // custo consumido = 840 - 300 = 540; por km = 540 / 900 = 0.60.
  assert.equal(r.custoPorKm, 0.6);
});

test("menos de 2 abastecimentos: consumo/custo nulos", async () => {
  const v = await seedVehicle();
  await seedEvent(v, "abastecimento", 500, 40, 250);
  const r = await fn.getFleetConsumption({
    data: { tenant_id: tenantId, vehicle_id: v },
    context: ctx(),
  });
  assert.equal(r.abastecimentos, 1);
  assert.equal(r.consumoMedio, null);
  assert.equal(r.custoPorKm, null);
  assert.equal(r.kmPercorridos, null);
});
