/**
 * O5-03b (Onda 5 — Ouvidoria) — painel da ouvidoria (Lei 13.460): COMPORTAMENTO.
 *
 * getOmbudsmanSummary consolida por tipo, conta em aberto/vencidas e a tempestividade das
 * respondidas. Vencida = em aberto (recebida/em_analise) com prazo passado; respondida no
 * prazo quando respondida_em <= prazo (limite), fora quando depois.
 *
 * Mutação: contar em aberto no prazo como vencida (ignorar prazo/status), ou tratar
 * resposta no limite como fora do prazo, derruba o teste.
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

const dir = mkdtempSync(join(tmpdir(), "ombudsman-summary-test-"));

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
async function seedManifestation({ tipo, status, prazo, respondidaEm = null }) {
  seq += 1;
  await db.query(
    `insert into public.ombudsman_manifestations
       (id, tenant_id, ano, numero, tipo, canal, descricao, status,
        prazo_resposta, respondida_em)
     values ($1,$2,2026,$3,$4,'web','Texto',$5,$6,$7)`,
    [randomUUID(), tenantId, seq, tipo, status, prazo, respondidaEm],
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
  Object.assign(fn, await bundle("src/lib/ombudsman.functions.ts", "omb.mjs"));
});

after(async () => {
  await db.close();
  delete globalThis.__db;
  rmSync(dir, { recursive: true, force: true });
});

test("consolida por tipo, vencidas e tempestividade", async () => {
  // Ref: 2026-06-01.
  // 2 denúncias: uma recebida vencida (prazo 05-01), uma respondida no prazo.
  await seedManifestation({
    tipo: "denuncia",
    status: "recebida",
    prazo: "2026-05-01",
  });
  await seedManifestation({
    tipo: "denuncia",
    status: "respondida",
    prazo: "2026-05-15",
    respondidaEm: "2026-05-10",
  });
  // 1 reclamação em análise, prazo futuro → em aberto, não vencida.
  await seedManifestation({
    tipo: "reclamacao",
    status: "em_analise",
    prazo: "2026-06-20",
  });
  // 1 elogio respondido EXATAMENTE no prazo → no prazo (limite <=).
  await seedManifestation({
    tipo: "elogio",
    status: "respondida",
    prazo: "2026-05-15",
    respondidaEm: "2026-05-15",
  });
  // 1 solicitação respondida fora do prazo.
  await seedManifestation({
    tipo: "solicitacao",
    status: "respondida",
    prazo: "2026-05-15",
    respondidaEm: "2026-05-25",
  });

  const r = await fn.getOmbudsmanSummary({
    data: { tenant_id: tenantId, data_referencia: "2026-06-01" },
    context: ctx(),
  });

  assert.equal(r.total, 5);
  assert.equal(r.porTipo.denuncia, 2);
  assert.equal(r.porTipo.reclamacao, 1);
  assert.equal(r.porTipo.elogio, 1);
  assert.equal(r.porTipo.solicitacao, 1);
  assert.equal(r.porTipo.sugestao, 0);
  // Em aberto: recebida + em_analise = 2; vencidas: só a recebida com prazo passado = 1.
  assert.equal(r.emAberto, 2);
  assert.equal(r.vencidas, 1);
  // Tempestividade: 05-10 e o exatamente-no-prazo 05-15 = 2 no prazo; 1 fora.
  assert.equal(r.respondidasNoPrazo, 2);
  assert.equal(r.respondidasForaPrazo, 1);
});
