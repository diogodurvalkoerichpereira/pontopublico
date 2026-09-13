/**
 * O4-04b (Onda 5) — lançamento em massa do IPTU do exercício: COMPORTAMENTO.
 *
 * launchIptuBatch gera o crédito (valor venal × alíquota) de TODOS os imóveis ativos que
 * ainda não têm IPTU no exercício; imóvel baixado, já lançado, ou com valor calculado ≤ 0 é
 * ignorado. Devolve lançados, ignorados e total. Rodar de novo não relança.
 *
 * Mutação: remover o /100 da alíquota infla o valor lançado — derruba o total.
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

const dir = mkdtempSync(join(tmpdir(), "iptu-batch-test-"));

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
async function seedProperty(venal, status = "ativo") {
  seq += 1;
  const id = randomUUID();
  await db.query(
    `insert into public.real_estate_properties
       (id, tenant_id, inscricao_imobiliaria, proprietario, proprietario_documento,
        endereco, valor_venal, status)
     values ($1,$2,$3,'Dono','00000000000','Rua X',$4,$5)`,
    [id, tenantId, `IM-${seq}`, venal, status],
  );
  return id;
}
const batch = () =>
  fn.launchIptuBatch({
    data: {
      tenant_id: tenantId,
      exercicio: 2026,
      aliquota: 1,
      vencimento: "2026-03-31",
    },
    context: ctx(),
  });
const iptuCount = async () =>
  (
    await db.query(
      "select count(*)::int as n from public.tax_credits where tributo='IPTU' and exercicio=2026",
    )
  ).rows[0].n;

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

test("lança IPTU de todos os ativos pendentes; pula baixado, já lançado e venal ínfimo", async () => {
  const p1 = await seedProperty(200000); // 1% → 2000
  await seedProperty(50000); // 1% → 500
  await seedProperty(300000, "baixado"); // baixado: fora
  await seedProperty(0.01); // 1% → 0.0001 → 0,00: ignorado

  // p1 já tem IPTU 2026 lançado avulso.
  await fn.launchIptu({
    data: {
      tenant_id: tenantId,
      property_id: p1,
      exercicio: 2026,
      aliquota: 1,
      vencimento: "2026-03-31",
    },
    context: ctx(),
  });
  assert.equal(await iptuCount(), 1);

  const r = await batch();
  assert.equal(r.lancados, 1); // só o de 50000 (p1 já lançado, baixado fora)
  assert.equal(r.ignorados, 1); // o venal ínfimo
  assert.equal(r.total_valor, 500);
  assert.equal(await iptuCount(), 2);

  // Rodar de novo não relança (o ínfimo segue ignorado, nada novo lançado).
  const r2 = await batch();
  assert.equal(r2.lancados, 0);
  assert.equal(r2.ignorados, 1);
  assert.equal(await iptuCount(), 2);
});

// O4-04c — imunidade/isenção: imóvel com benefício fica fora do lote e do avulso;
// encerrado o benefício, volta a lançar. Conceder exige fundamento.
test("imóvel imune/isento não lança IPTU (lote nem avulso); encerrar o benefício volta a lançar", async () => {
  const templo = await seedProperty(400000); // 1% → 4000 se lançasse
  const setBenefit = (beneficio, motivo) =>
    fn.setPropertyTaxBenefit({
      data: { tenant_id: tenantId, property_id: templo, beneficio, motivo },
      context: ctx(),
    });

  // Conceder sem fundamento é recusado.
  await assert.rejects(setBenefit("imunidade", ""), /fundamento/i);
  const g = await setBenefit("imunidade", "CF art. 150, VI, b — templo");
  assert.equal(g.beneficio_iptu, "imunidade");

  const antes = await iptuCount();
  const r = await batch();
  assert.equal(r.isentos, 1); // o templo, contado à parte
  assert.equal(r.lancados, 0); // e NÃO lançado
  assert.equal(await iptuCount(), antes);

  // Avulso também recusa.
  await assert.rejects(
    fn.launchIptu({
      data: {
        tenant_id: tenantId,
        property_id: templo,
        exercicio: 2026,
        aliquota: 1,
        vencimento: "2026-03-31",
      },
      context: ctx(),
    }),
    /imunidade/i,
  );

  // Encerrado o benefício, o lote passa a lançar o imóvel.
  await setBenefit(null);
  const r2 = await batch();
  assert.equal(r2.isentos, 0);
  assert.equal(r2.lancados, 1);
  assert.equal(r2.total_valor, 4000);
  assert.equal(await iptuCount(), antes + 1);
});
