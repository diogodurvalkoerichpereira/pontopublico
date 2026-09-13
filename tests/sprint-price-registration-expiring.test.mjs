/**
 * O3-12e (Onda 5) — alerta de vigência das atas de registro de preços: COMPORTAMENTO.
 *
 * getExpiringPriceRegistrations lista as atas ainda 'vigente' já vencidas (vigencia_fim <
 * referência → dias_para_vencer negativo) ou que vencem dentro da janela de alerta; conta
 * vencidas × a vencer. Ata fora da janela ou não-vigente (encerrada/cancelada) fica de fora.
 *
 * Mutação: remover o filtro status='vigente' inclui atas encerradas — derruba.
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

const dir = mkdtempSync(join(tmpdir(), "price-expiring-test-"));

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
async function seedAta(vigenciaFim, status) {
  seq += 1;
  const processId = randomUUID();
  await db.query(
    `insert into public.procurement_processes
       (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado, status, abertura)
     values ($1,$2,$3,2026,'pregao','SRP',100000,'homologada','2026-01-10')`,
    [processId, tenantId, `PLS-${seq}`],
  );
  const id = randomUUID();
  await db.query(
    `insert into public.price_registrations
       (id, tenant_id, procurement_process_id, numero, ano, fornecedor,
        vigencia_inicio, vigencia_fim, status)
     values ($1,$2,$3,$4,2026,'Fornecedor','2026-01-01',$5,$6)`,
    [id, tenantId, processId, `ATA-${seq}`, vigenciaFim, status],
  );
  return id;
}

const expiring = () =>
  fn.getExpiringPriceRegistrations({
    data: {
      tenant_id: tenantId,
      data_referencia: "2026-06-01",
      dias_alerta: 30,
    },
    context: ctx(),
  });

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
    await bundle("src/lib/price-registration.functions.ts", "pr.mjs"),
  );
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("lista atas vigentes vencidas e a vencer; ignora fora da janela e não-vigente", async () => {
  await seedAta("2026-05-20", "vigente"); // vencida (-12 dias)
  await seedAta("2026-06-20", "vigente"); // a vencer (19 dias)
  await seedAta("2026-09-01", "vigente"); // fora da janela de 30 dias
  await seedAta("2026-05-20", "encerrada"); // vencida, mas encerrada: fora

  const r = await expiring();
  assert.equal(r.registrations.length, 2);
  assert.equal(r.vencidas, 1);
  assert.equal(r.aVencer, 1);
  // Ordenada por vigencia_fim: a vencida (05-20) vem antes da a vencer (06-20).
  assert.equal(r.registrations[0].dias_para_vencer, -12);
  assert.equal(r.registrations[1].dias_para_vencer, 19);
});
