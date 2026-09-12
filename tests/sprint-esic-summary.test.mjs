/**
 * O5-04b (Onda 5 — e-SIC/LAI) — painel de prazos: COMPORTAMENTO.
 *
 * getEsicSummary consolida a contagem por situação, destaca os pedidos EM ABERTO
 * (recebido/prorrogado) com prazo vencido e a tempestividade dos respondidos/indeferidos
 * (dentro do prazo quando respondido até o prazo; fora quando depois). Seeda pedidos em
 * várias combinações e confere vencidos e o recorte de tempestividade.
 *
 * Mutação: contar pedido em aberto no prazo como vencido (ignorar prazo), ou classificar
 * um respondido fora do prazo como no prazo (trocar > por <=), derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "esic-summary-test-"));

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
  `const PERMS = ["protocol.read","protocol.manage"];
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
async function seedRequest({ status, prazo, respondidoEm = null }) {
  seq += 1;
  await db.query(
    `insert into public.esic_requests
       (id, tenant_id, ano, numero, solicitante, pedido, status, prazo_resposta, respondido_em)
     values ($1,$2,2026,$3,'Cidadao','Solicito informacao',$4,$5,$6)`,
    [randomUUID(), tenantId, seq, status, prazo, respondidoEm],
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
  Object.assign(fn, await bundle("src/lib/esic.functions.ts", "esic.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("conta por situação, vencidos e tempestividade dos respondidos", async () => {
  // Referência: 2026-06-01.
  // Recebido, prazo passado (05-01) → VENCIDO.
  await seedRequest({ status: "recebido", prazo: "2026-05-01" });
  // Prorrogado, prazo passado (05-20) → VENCIDO.
  await seedRequest({ status: "prorrogado", prazo: "2026-05-25" });
  // Recebido, prazo futuro (06-15) → em aberto, não vencido.
  await seedRequest({ status: "recebido", prazo: "2026-06-15" });
  // Respondido no prazo (respondido_em 05-10 <= prazo 05-15).
  await seedRequest({
    status: "respondido",
    prazo: "2026-05-15",
    respondidoEm: "2026-05-10",
  });
  // Respondido fora do prazo (respondido_em 05-20 > prazo 05-15).
  await seedRequest({
    status: "respondido",
    prazo: "2026-05-15",
    respondidoEm: "2026-05-20",
  });
  // Indeferido no prazo.
  await seedRequest({
    status: "indeferido",
    prazo: "2026-04-30",
    respondidoEm: "2026-04-25",
  });
  // Respondido EXATAMENTE no prazo (respondido_em == prazo) → no prazo (limite <=).
  await seedRequest({
    status: "respondido",
    prazo: "2026-05-15",
    respondidoEm: "2026-05-15",
  });

  const r = await fn.getEsicSummary({
    data: { tenant_id: tenantId, data_referencia: "2026-06-01" },
    context: ctx(),
  });

  assert.equal(r.total, 7);
  assert.equal(r.porStatus.recebido, 2);
  assert.equal(r.porStatus.prorrogado, 1);
  assert.equal(r.porStatus.respondido, 3);
  assert.equal(r.porStatus.indeferido, 1);
  // Vencidos: só os dois em aberto com prazo passado.
  assert.equal(r.vencidos, 2);
  // Tempestividade: 05-10, 04-25 e o exatamente-no-prazo 05-15 = 3 no prazo; 1 fora.
  assert.equal(r.respondidosNoPrazo, 3);
  assert.equal(r.respondidosForaPrazo, 1);
});
