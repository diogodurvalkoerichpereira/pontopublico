/**
 * O3-12d (Onda 3) — histórico (razão) de consumos da ata de registro de preços:
 * COMPORTAMENTO.
 *
 * Cada drawFromPriceRegistration passa a gravar uma linha em
 * price_registration_draws, valorada (quantidade × preço registrado);
 * getPriceRegistrationDraws lista os consumos da ata em ordem cronológica e
 * consolida o total consumido.
 *
 * Mutação: não gravar o consumo (razão vazio) ou valorar errado (quantidade sem o
 * preço) derruba.
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

const dir = mkdtempSync(join(tmpdir(), "price-draws-test-"));

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

test("cada consumo entra no razão da ata, valorado e cronológico; total consolida", async () => {
  const processId = randomUUID();
  await db.query(
    `insert into public.procurement_processes
       (id, tenant_id, numero, ano, modalidade, objeto, valor_estimado, status, abertura)
     values ($1,$2,'PL-1',2026,'pregao','Registro de precos',100000,'homologada','2026-01-10')`,
    [processId, tenantId],
  );
  const ata = await fn.createPriceRegistration({
    data: {
      tenant_id: tenantId,
      procurement_process_id: processId,
      numero: "ATA-1",
      ano: 2026,
      fornecedor: "Fornecedor X",
      vigencia_inicio: "2026-02-01",
      vigencia_fim: "2026-12-31",
      itens: [
        {
          descricao: "Papel A4",
          unidade: "resma",
          quantidade_registrada: 100,
          preco_unitario: 20,
        },
      ],
    },
    context: ctx(),
  });
  const itemId = (
    await db.query(
      "select id from public.price_registration_items where registration_id=$1",
      [ata.id],
    )
  ).rows[0].id;

  // Dois consumos: 10 (em março) e 5 (em abril).
  await fn.drawFromPriceRegistration({
    data: {
      tenant_id: tenantId,
      item_id: itemId,
      quantidade: 10,
      data_referencia: "2026-03-05",
    },
    context: ctx(),
  });
  await fn.drawFromPriceRegistration({
    data: {
      tenant_id: tenantId,
      item_id: itemId,
      quantidade: 5,
      data_referencia: "2026-04-02",
    },
    context: ctx(),
  });

  const r = await fn.getPriceRegistrationDraws({
    data: { tenant_id: tenantId, registration_id: ata.id },
    context: ctx(),
  });
  assert.equal(r.draws.length, 2);
  // Cronológico: março antes de abril.
  assert.equal(r.draws[0].data_referencia, "2026-03-05");
  assert.equal(r.draws[1].data_referencia, "2026-04-02");
  // Valor = quantidade × preço registrado (20).
  assert.equal(r.draws[0].quantidade, 10);
  assert.equal(r.draws[0].valor, 200);
  assert.equal(r.draws[1].valor, 100);
  assert.equal(r.draws[0].descricao, "Papel A4");
  // Total consolidado.
  assert.equal(r.totalConsumido, 300);
});
