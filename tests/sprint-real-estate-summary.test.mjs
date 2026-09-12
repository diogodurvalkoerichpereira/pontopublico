/**
 * O4-04b (Onda 4) — Resumo do cadastro imobiliário (base do IPTU): COMPORTAMENTO.
 *
 * getRealEstateSummary consolida a contagem de imóveis por situação e, dos ATIVOS, o valor
 * venal total e a área construída — a base tributável do IPTU. Imóvel baixado não integra
 * a base.
 *
 * Mutação: somar o valor venal sem o filtro status='ativo' (incluir baixados na base)
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
let userId;
const fn = {};

const dir = mkdtempSync(join(tmpdir(), "real-estate-summary-test-"));

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
  `const PERMS = ["taxes.read","taxes.manage"];
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
async function seedProperty({ valorVenal, areaConstruida, status = "ativo" }) {
  seq += 1;
  await db.query(
    `insert into public.real_estate_properties
       (id, tenant_id, inscricao_imobiliaria, proprietario, proprietario_documento,
        endereco, valor_venal, area_construida, status)
     values ($1,$2,$3,'Proprietario','00000000000','Rua X',$4,$5,$6)`,
    [randomUUID(), tenantId, `IM-${seq}`, valorVenal, areaConstruida, status],
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
  Object.assign(fn, await bundle("src/lib/real-estate.functions.ts", "re.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("base tributável soma só os imóveis ativos", async () => {
  await seedProperty({ valorVenal: 200000, areaConstruida: 120 });
  await seedProperty({ valorVenal: 300000, areaConstruida: 80 });
  // Baixado: fora da base do IPTU.
  await seedProperty({
    valorVenal: 500000,
    areaConstruida: 200,
    status: "baixado",
  });

  const r = await fn.getRealEstateSummary({
    data: { tenant_id: tenantId },
    context: ctx(),
  });

  assert.equal(r.ativos, 2);
  assert.equal(r.baixados, 1);
  assert.equal(r.valorVenalTributavel, 500000); // 200000 + 300000, sem o baixado
  assert.equal(r.areaConstruidaTotal, 200); // 120 + 80
});
